import { musicPlayingInSession } from "../music-playback";
import { DEFAULT_VAD } from '../api';
import { EchoProbe, settleFor } from '../echo-guard';
import { local, session } from '../safe-storage';
import { VoiceProfiler, replyMarks } from '../voice-profile';
import { VoiceProfile } from './VoiceProfile';
import type { Activity } from '../transcript';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { voiceCue, type VoiceCue } from "../voice-cues";
import { createPortal } from "react-dom";
import { VoiceStage, type VoiceLevels } from "./VoiceStage";
import { LuAudioLines, LuLoaderCircle, LuGauge } from "react-icons/lu";
import type { MicVAD } from "@ricky0123/vad-web";
import { api, json, type PortalEvent, type PromptOptions } from "../api";
import { micError } from "../mic-error";
import type { Item } from "../transcript";
import { LiveTranscription } from "../live-transcription";
import { StreamedTranscription } from "../live-rtc";
import { RtcStt, type RtcSpeaker } from "../rtc-stt";
import { ignoresUnknown, speakerForPrompt, unknownVoicesFrom, type UnknownVoices } from "../speaker-filter";
import { suppressNoise, type NoiseModel, type Suppressed } from "../noise";
import { preparePcmSpeech, readPcmStream, playAudioBuffer, bufferOf } from "../pcm-stream";
import { OPUS_RATE, oggOpusToPcm, opusSupported } from "../ogg-opus";
import { stretch, stretchInSteps } from "../time-stretch";
import { joinSamples } from "../samples";
import { asksToRepeat, couldAskToRepeat } from "../voice-commands";
import { isImage, pending, type Attachment } from "../attachments";
import { VOICE_RATES } from "./VoiceSettings";
import { matches, useKeybindings } from "../keybindings";
import { HandsFreeVoice, type VoicePhase } from "../hands-free";
import { t } from "../i18n";
import { MiniCpmDuplexControl } from "./MiniCpmDuplexControl";

/** How much of the last reply Repeat keeps: two minutes is about 11 MB of samples. */
const REPEAT_SECONDS = 120;
/** A phrase of the last reply, and the last speed Repeat played it at, so a second Repeat need not work it out again. */
type KeptPhrase = { samples: Float32Array[]; sampleRate: number; stretched?: { rate: number; samples: Promise<Float32Array>; signal: AbortSignal; ready?: boolean } };
const seconds = (phrase: KeptPhrase) => phrase.samples.reduce((n, s) => n + s.length, 0) / phrase.sampleRate;

export function VoiceControl({ canvasOpen, onCanvasMinimize, onCanvasToggle, sessionId, folder, items, running, work, onSend, onAbort, stageTarget, onModeChange, title, browserAvailable, browserActivity, terminalActivity, toolEvents }: {
  sessionId: string;
  /** The folder the chat works in, for the Files window. */
  folder: string;
  canvasOpen: boolean; onCanvasMinimize: () => void; onCanvasToggle: () => void;
  stageTarget: HTMLElement | null;
  onModeChange: (active: boolean) => void;
  title: string;
  browserAvailable: boolean; browserActivity: number; terminalActivity: number; toolEvents: PortalEvent[];
  items: Item[];
  running: boolean;
  /** What the agent is doing now (the chat works it out once, from the same events), or null when it is not running. */
  work: Activity | null;
  onSend: (text: string, options?: PromptOptions) => Promise<void>;
  onAbort: () => Promise<void>;
}) {
  const [profileOpen,setProfileOpen]=useState(false);
  const profiling=useRef(false);profiling.current=profileOpen;
  const [,refreshProfile]=useState(0);
  const profiler=useRef<VoiceProfiler>();
  if(!profiler.current)profiler.current=new VoiceProfiler(()=>refreshProfile(n=>n+1));
  // Read again only when there are new events: this component is drawn with every key typed in the chat's box.
  const newestSeq=useMemo(()=>toolEvents.reduce((n,e)=>Math.max(n,e.seq),0),[toolEvents]);
  const eventSeq=useRef(0);eventSeq.current=newestSeq;
  const profileSeq=useRef(Infinity);
  const profileLiveSeen=useRef(new WeakSet<object>());
  const profileMark=(name:string)=>{if(profiling.current)profiler.current!.mark(name);};
  useEffect(()=>{
    if(!profiling.current)return;
    for(const event of toolEvents){
      if(event.seq < 0) { if(profileLiveSeen.current.has(event))continue; profileLiveSeen.current.add(event); }
      else { if(event.seq<=profileSeq.current)continue; profileSeq.current=event.seq; }
      for(const name of replyMarks(event))profileMark(name);
      if(event.type==='portal_prefill')profiler.current!.mark('prefill_progress',{total:event.payload?.total??0,processed:event.payload?.processed??0,cache:event.payload?.cache??0,timeMs:event.payload?.timeMs??0});
      if(['portal_prompt','compaction_start','compaction_end','tool_execution_start','tool_execution_end','agent_end'].includes(event.type))profileMark(event.type);
    }
  },[toolEvents]);
  // Pictures waiting to go with the next thing said: the same ones as in the
  // chat's message box, so they are there before voice mode and after it.
  const [attachments, setAttachments] = useState<Attachment[]>(() => pending.get(sessionId));
  useEffect(() => pending.subscribe(id => { if (id === sessionId) setAttachments(pending.get(id)); }), [sessionId]);
  const addPictures = async (files: File[]) => {
    const pictures = files.filter(file => isImage(file.type));
    const problems = pictures.length < files.length ? [t("Only PNG, JPEG, GIF and WebP pictures can be sent in voice mode. Put other files in Files.")] : [];
    problems.push(...await pending.add(sessionId, pictures));
    if (problems.length && mounted.current) setError(problems.join(" "));
  };
  // What talking mid-run does, how fast replies are spoken, and push-to-talk:
  // read by the controller and the speech at the moment they matter.
  const [steer, setSteer] = useState(() => local.get('voiceSteer') === 'on');
  const steering = useRef(steer); steering.current = steer;
  // What to do with a voice that is not enrolled: hear it, ignore it, or (default) have the agent ask who it is (see speaker-filter.ts).
  const [unknownVoices, setUnknownVoices] = useState<UnknownVoices>(() => unknownVoicesFrom(local.get('voiceOnlyOwner')));
  const unknownVoicesNow = useRef(unknownVoices); unknownVoicesNow.current = unknownVoices;
  /** The verdict for the utterance being finished, set by whichever path transcribed it. */
  const speakerNow = useRef<RtcSpeaker | undefined>(undefined);
  const [rate, setRate] = useState(() => { const saved = Number(local.get('voiceRate')); return VOICE_RATES.includes(saved) ? saved : 1; });
  const speed = useRef(rate); speed.current = rate;
  const [ptt, setPtt] = useState(() => local.get('voicePtt') === 'on');
  const pushToTalk = useRef(ptt); pushToTalk.current = ptt;
  const [holding, setHolding] = useState(false);
  /** A push-to-talk press: what was heard, how much of it while still held, and the most speech-like frame. */
  const held = useRef<{ frames: Float32Array[]; releasing: boolean; heldFrames: number; speech: number; started: boolean; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const holdLimit = useRef<ReturnType<typeof setTimeout>>();
  // The last reply as it was spoken, phrase by phrase, for Repeat. Samples as
  // they came from the speech service, before the speed was applied. Only the
  // last REPEAT_SECONDS of it: a long run that talks before every step would
  // otherwise keep all of that audio.
  const replyAudio = useRef<KeptPhrase[]>([]);
  const [canRepeat, setCanRepeat] = useState(false);
  const replay = useRef<AbortController | null>(null);
  const [sounds, setSounds] = useState(() => local.get('voiceSounds') !== 'off');
  const soundsEnabled = useRef(sounds); soundsEnabled.current = sounds;
  const soundContext = useRef<AudioContext | null>(null);
  const cue = useCallback((kind: VoiceCue) => { if (soundsEnabled.current && soundContext.current) voiceCue(soundContext.current, kind); }, []);
  const toggleSounds = () => setSounds(value => { local.set('voiceSounds', value ? 'off' : 'on'); return !value; });
  const [available, setAvailable] = useState(false);
  // After a reload voice mode comes back, but audio may not start until the
  // page has been touched: the stage is shown and waits for that.
  const [waitingForTap, setWaitingForTap] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [starting, setStarting] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("Listening");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [transcript, setTranscript] = useState("");
  /** Who spoke the last utterance (portal-side voice identification, off unless VOICE_SPEAKER_ID); cleared when the next one starts. */
  const [speaker, setSpeaker] = useState<RtcSpeaker | undefined>(undefined);
  const transcription = useRef<StreamedTranscription | null>(null);
  const rtcStt = useRef<RtcStt | undefined>(undefined);
  const rtcEnabled = useRef(false);
  const noiseModel = useRef<NoiseModel>('off');
  const cleaned = useRef<Suppressed | undefined>(undefined);
  const [speaking, setSpeaking] = useState(false);
  const [duplexActive, setDuplexActive] = useState(false);
  const [duplexHearing, setDuplexHearing] = useState(false);
  const [duplexError, setDuplexError] = useState("");
  const [duplexCapture, setDuplexCapture] = useState({label: "Microphone", level: 0, muted: false});
  const duplexReconnectRef = useRef<(() => Promise<void>) | null>(null);
  const [duplexMuted, setDuplexMuted] = useState(false);
  const [duplexCaption, setDuplexCaption] = useState("");
  const duplexToggleRef = useRef<(() => void) | null>(null);
  const [duplexActivity, setDuplexActivity] = useState("listening");
  const [duplexState, setDuplexState] = useState("closed");
  const duplexActiveRef = useRef(false);
  const duplexMuteRef = useRef<(() => void) | null>(null);
  const [musicPlaying, setMusicPlaying] = useState(false);
  const musicPlayingRef = useRef(false);
  const musicRestoreMuted = useRef(false);
  const mutedRef = useRef(false);
  const muteBusy = useRef(false);
  const startButton = useRef<HTMLButtonElement>(null);
  const levels = useRef<VoiceLevels>({ input: 0, output: 0 });
  const compactionEvent = useMemo(() => {
    for (let i = toolEvents.length - 1; i >= 0; i--) if (toolEvents[i].type === 'compaction_start' || toolEvents[i].type === 'compaction_end') return toolEvents[i];
  }, [toolEvents]);
  const compacting = running && compactionEvent?.type === 'compaction_start';
  const latest = useRef({ items, running, onSend, onAbort, compacting });
  latest.current = { items, running, onSend, onAbort, compacting };
  const epoch = useRef(0);
  const mounted = useRef(false);
  const restoring = useRef(false);
  // Read once, as the chat opens: whether voice mode was on in this tab before a reload.
  const resume = useRef<boolean | null>(null);
  if (resume.current === null) resume.current = session.get('voiceActive') === sessionId && session.get('voiceDuplexActive') !== sessionId;
  // Held while voice mode is on in this tab. A duplicated tab gets a copy of
  // session storage, so the flag alone would start a second voice session on
  // the same chat; the lock is how it finds this one still going.
  const lockName = `voice:${sessionId}`;
  const releaseLock = useRef<(() => void) | undefined>();
  /**
   * Takes that lock for as long as voice mode is on here. False only when
   * voice mode is being brought back and another tab has it: the tab this one
   * was duplicated from. Turned on by hand, it goes on either way.
   */
  const claim = async (version: number, resuming: boolean): Promise<boolean> => {
    if (!navigator.locks) return true;
    for (let attempt = 0; ; attempt++) {
      const got = await new Promise<boolean>(resolve => {
        navigator.locks.request(lockName, { ifAvailable: true }, lock => {
          resolve(!!lock);
          if (!lock || epoch.current !== version) return;
          return new Promise<void>(release => { releaseLock.current = release; });
        }).catch(() => resolve(true));
      });
      if (got || !resuming) return true;
      if (attempt >= 3 || epoch.current !== version) return false;
      // The page before the reload may take a moment to let go of it.
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  };
  const voice = useRef<HandsFreeVoice | null>(null);
  const vad = useRef<MicVAD | null>(null);
  // Speech heard while a reply plays: the reply is turned down and the VAD watched, to tell a person from the reply's own echo.
  const echoProbe = useRef(new EchoProbe());
  const echoSegment = useRef(false);
  /** What the input watchdog knows: when a VAD frame last came, when one last carried any sound, whether the raw microphone replaced the cleaned one. */
  const inputWatch = useRef<{ lastFrame: number; liveAt: number; raw: boolean; timer?: ReturnType<typeof setInterval> }>({ lastFrame: 0, liveAt: 0, raw: false });
  const reconnectRtc = useRef<() => void>(() => {});
  const playGain = useRef<GainNode | null>(null);
  const ducked = useRef(false);
  const duck = (on: boolean) => {
    ducked.current = on;
    const node = playGain.current;
    if (node) { try { node.gain.setTargetAtTime(on ? 0 : 1, node.context.currentTime, on ? 0.01 : 0.03); } catch { /* the node is gone */ } }
  };
  const vadSettings = useRef(DEFAULT_VAD);
  const sequential = useRef(false);
  const statusSpeech = useRef(true);
  /** The language this chat's replies are in (GET /api/sessions/:id/voice/language), for the spoken status phrases; null = not known. */
  const spokenLanguage = useRef<'tr' | 'en' | null>(null);
  const [comparison, setComparison] = useState(false);
  const sentenceChunks = useRef(false);
  /** The rate the speech engine streams at (GET /api/voice): the audio context runs at it, so streamed speech is never resampled. */
  const speechRate = useRef(24000);
  const mergeReplies = useRef(false);
  const ttsPrefetch = useRef(false);
  const [prefetchMode, setPrefetchMode] = useState(false);
  const [sentenceMode, setSentenceMode] = useState(false);
  const [sequentialMode, setSequentialMode] = useState(false);
  const context = useRef<AudioContext | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const managed = useRef(false);
  const connection = useRef<string | null>(null);
  const heartbeat = useRef<ReturnType<typeof setInterval>>();
  const connectVoice = async(client:string,active:boolean)=>{
    await json(`/api/sessions/${sessionId}/voice/connection`,{method:'POST',body:JSON.stringify({client,active}),keepalive:!active});
  };
  const maxTurn = useRef<ReturnType<typeof setTimeout>>();

  const stop = () => {
    profiler.current?.close('stopped');
    musicPlayingRef.current = false; musicRestoreMuted.current = false;
    if (mounted.current) setMusicPlaying(false);
    // Ended, or left for another chat: a reload after this does not bring it back.
    if (session.get('voiceActive') === sessionId) session.remove('voiceActive');
    releaseLock.current?.(); releaseLock.current = undefined;
    epoch.current++;
    clearInterval(heartbeat.current);
    const lease=connection.current;connection.current=null;
    if(lease)void connectVoice(lease,false).catch(()=>{});
    const sound = soundContext.current; soundContext.current = null;
    if (sound) { if (soundsEnabled.current && mounted.current) voiceCue(sound, 'end'); setTimeout(() => { if (sound.state !== 'closed') void sound.close(); }, 180); }
    mutedRef.current = false;
    levels.current = { input: 0, output: 0 };
    clearTimeout(maxTurn.current); clearInterval(inputWatch.current.timer); inputWatch.current = { lastFrame: 0, liveAt: 0, raw: false }; reconnectRtc.current = () => {};
    clearTimeout(holdLimit.current); clearTimeout(held.current?.timer); held.current = null;
    replay.current?.abort(); replay.current = null;
    voice.current?.stop(); voice.current = null;
    transcription.current?.reset(); transcription.current = null;
    rtcStt.current?.close(); rtcStt.current = undefined;
    cleaned.current?.close(); cleaned.current = undefined;
    echoProbe.current.stop(); echoSegment.current = false; ducked.current = false;
    const detector = vad.current; vad.current = null;
    void detector?.destroy().catch(() => {});
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
    const audio = context.current; context.current = null;
    if (audio && audio.state !== "closed") void audio.close();
    if (mounted.current) { setEnabled(false); setStarting(false); setMuted(false); setSpeaking(false); setTranscript(""); setHolding(false); setWaitingForTap(false); }
  };
  useEffect(() => {
    mounted.current = true;
    const load = () => api.voice().then(config => {
      if (!mounted.current) return;
      managed.current=config.managed===true;
      statusSpeech.current = config.statusSpeech !== false;
      setComparison(config.comparison === true);
      sequential.current = config.pipelineMode === "sequential";
      setSequentialMode(sequential.current);
      sentenceChunks.current = config.sentenceChunks === true;
      mergeReplies.current = config.mergeReplies === true;
      speechRate.current = config.speechSampleRate === 48000 ? 48000 : 24000;
      rtcEnabled.current = config.sttWebrtc === true && typeof RTCPeerConnection !== 'undefined';
      noiseModel.current = config.noiseModel === 'rnnoise' || config.noiseModel === 'gtcrn' ? config.noiseModel : 'off';
      setSentenceMode(sentenceChunks.current);
      ttsPrefetch.current = config.ttsPrefetch === true;
      setPrefetchMode(ttsPrefetch.current);
      vadSettings.current = { ...DEFAULT_VAD, ...config.vad };
      // Voice mode speaks its replies: without speech synthesis there is nothing for it to do. Dictation, which only listens, stays.
      const usable = config.enabled && config.speech !== false;
      setAvailable(usable);
      if (!usable) stop();
      // Voice mode was on in this tab when the page was reloaded: carry on.
      else if (resume.current && !voice.current && !restoring.current) { restoring.current = true; void start(true); }
    }).catch(() => { if (mounted.current) { setAvailable(false); stop(); } });
    void load();
    window.addEventListener("voice-config-changed", load);
    return () => { mounted.current = false; window.removeEventListener("voice-config-changed", load); stop(); };
  }, []);
  useEffect(() => {
    voice.current?.setCompacting(compacting, compactionEvent?.type === 'compaction_end' && !compactionEvent.payload?.aborted && !compactionEvent.payload?.errorMessage);
    voice.current?.observe(items);
    if (compacting) transcription.current?.discard();
  }, [items, running, compacting, compactionEvent]);
  useEffect(() => {
    onModeChange(enabled || starting || duplexActive);
    return () => onModeChange(false);
  }, [enabled, starting, duplexActive, onModeChange]);

  const toggleMute = async () => {
    const detector = vad.current;
    if (!detector || muteBusy.current) return;
    const version = epoch.current;
    const next = !mutedRef.current;
    muteBusy.current = true;
    mutedRef.current = next;
    setMuted(next); cue(next ? "mute" : "unmute");
    clearTimeout(maxTurn.current);
    levels.current.input = 0;
    voice.current?.setMuted(next);
    if (next) {transcription.current?.reset();profiler.current?.close('muted');}
    try {
      if (next) {
        stream.current?.getTracks().forEach(track => { track.enabled = false; });
        detector.setOptions({ submitUserSpeechOnPause: false });
        await detector.pause();
      } else {
        detector.setOptions({ submitUserSpeechOnPause: true });
        stream.current?.getTracks().forEach(track => { track.enabled = true; });
        await detector.start();
      }
    } catch (e) {
      if (epoch.current === version) { setError((e as Error).message); stop(); }
    } finally { muteBusy.current = false; }
  };
  const setMusicMicPaused = async (paused: boolean) => {
    const audioPlaying = paused;
    if (paused && !musicPlayingRef.current) musicRestoreMuted.current = mutedRef.current;
    if (!paused && musicPlayingRef.current) paused = musicRestoreMuted.current;
    if (!vad.current || paused === mutedRef.current) { musicPlayingRef.current = audioPlaying; setMusicPlaying(audioPlaying); return; }
    const version = epoch.current;
    const detector = vad.current;
    mutedRef.current = paused;
    setMuted(paused);
    voice.current?.setMuted(paused);
    if (paused) transcription.current?.reset();
    try {
      stream.current?.getTracks().forEach(track => { track.enabled = !paused; });
      detector.setOptions({ submitUserSpeechOnPause: !paused });
      if (paused) await detector.pause(); else await detector.start();
      if (epoch.current === version) { musicPlayingRef.current = audioPlaying; setMusicPlaying(audioPlaying); }
    } catch (e) {
      if (epoch.current === version) { setError((e as Error).message); stop(); }
    }
  };
  useEffect(() => {
    if (enabled) void setMusicMicPaused(musicPlayingInSession(sessionId));
  }, [enabled, sessionId]);
  useEffect(() => {
    const playback = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; playing: boolean }>).detail;
      if (detail?.sessionId === sessionId && session.get('voiceActive') === sessionId) void setMusicMicPaused(detail.playing);
    };
    window.addEventListener("yulify:music-playback", playback);
    return () => window.removeEventListener("yulify:music-playback", playback);
  }, [sessionId]);
  /** Push-to-talk pressed or let go. A press too short to hold a word is not sent. */
  const hold = (down: boolean) => {
    const controller = voice.current, live = transcription.current;
    if (!pushToTalk.current || !controller || !live || !vad.current) return;
    if (down) {
      let press = held.current;
      if (press && !press.releasing) return;
      replay.current?.abort();
      setHolding(true); setError("");
      if (press) {
        // Pressed again before the last press was sent: the same utterance goes on.
        clearTimeout(press.timer); press.releasing = false;
      } else {
        press = held.current = { frames: [], releasing: false, heldFrames: 0, speech: 0, started: false };
        stream.current?.getTracks().forEach(track => { track.enabled = true; });
        if (profiling.current) profiler.current!.begin();
        if (!latest.current.compacting) { live.begin(); live.confirm(); }
      }
      // Only a press held long enough to be words interrupts what is being said.
      const current = press;
      if (!current.started) current.timer = setTimeout(() => {
        if (held.current !== current || current.releasing) return;
        current.started = true; controller.speechStart();
      }, 250);
      // As long as a turn may be: the same bound as hands-free listening.
      clearTimeout(holdLimit.current);
      holdLimit.current = setTimeout(() => hold(false), 60000);
      return;
    }
    const press = held.current;
    if (!press || press.releasing) return;
    press.releasing = true; clearTimeout(holdLimit.current); clearTimeout(press.timer);
    setHolding(false);
    // The last syllable is still on its way through the detector.
    press.timer = setTimeout(() => {
      if (held.current !== press) return;
      held.current = null;
      if (pushToTalk.current) stream.current?.getTracks().forEach(track => { track.enabled = false; });
      levels.current.input = 0;
      const samples = joinSamples(press.frames);
      // Held for under a quarter of a second, or nothing in it the detector took
      // for speech: a tap or a cough, not something to send.
      const heldFor = press.frames.slice(0, press.heldFrames).reduce((n, f) => n + f.length, 0);
      if (!press.started || heldFor < 4000 || press.speech < 0.5 || latest.current.compacting) { live.discard(); controller.speechCancel(); return; }
      profileMark('endpoint'); live.end(samples); controller.speechEnd(samples);
    }, 250);
  };
  const choosePtt = async (on: boolean) => {
    local.set('voicePtt', on ? 'on' : 'off');
    setPtt(on); pushToTalk.current = on;
    if (!on && held.current) { clearTimeout(held.current.timer); held.current = null; setHolding(false); voice.current?.speechCancel(); transcription.current?.discard(); }
    // Anything said hands-free so far is dropped: its end is no longer listened for.
    if (on && !held.current) { clearTimeout(maxTurn.current); voice.current?.speechCancel(); transcription.current?.discard(); }
    if (!vad.current) return;
    // Push-to-talk has no mute of its own; it starts from an open detector.
    if (on && mutedRef.current) await toggleMute();
    stream.current?.getTracks().forEach(track => { track.enabled = !on && !mutedRef.current; });
  };
  const endMode = () => {
    stop();
    requestAnimationFrame(() => startButton.current?.focus({ preventScroll: true }));
  };

  useEffect(() => {
    const end = (event: Event) => {
      if ((event as CustomEvent).detail?.sessionId === sessionId && session.get("voiceActive") === sessionId && !duplexActiveRef.current) endMode();
    };
    window.addEventListener("yulify:end-voice", end);
    return () => window.removeEventListener("yulify:end-voice", end);
  }, [sessionId]);

  /** Plays one prepared phrase through the orb's meter. Shared by replies and Repeat. */
  const playThrough = async (audio: AudioContext, signal: AbortSignal, start: (analyser: AnalyserNode, started: (scheduledAt?: number) => void) => Promise<void>, onStarted?: (scheduledAt: number) => void) => {
    signal.throwIfAborted();
    const analyser = audio.createAnalyser(); analyser.fftSize = 256;
    const gain = audio.createGain(); gain.gain.value = ducked.current ? 0 : 1; playGain.current = gain;
    analyser.connect(gain); gain.connect(audio.destination);
    const samples = new Float32Array(analyser.fftSize);
    let animation = 0;
    const meter = () => {
      analyser.getFloatTimeDomainData(samples);
      levels.current.output = Math.min(1, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) * 5);
      animation = requestAnimationFrame(meter);
    };
    try {
      await start(analyser, (scheduledAt = audio.currentTime) => { onStarted?.(scheduledAt); setSpeaking(true); meter(); });
    } finally {
      analyser.disconnect(); gain.disconnect(); if (playGain.current === gain) playGain.current = null; cancelAnimationFrame(animation); levels.current.output = 0;
      if (mounted.current) setSpeaking(false);
    }
  };
  /** The last reply again, at the speed chosen now. False when there is none to play. */
  const repeatReply = (): boolean => {
    const audio = context.current;
    const phrases = replyAudio.current.filter(p => p.samples.length);
    if (!audio || !phrases.length) return false;
    replay.current?.abort();
    const controller = new AbortController(); replay.current = controller;
    const rate = speed.current;
    const prepare = (phrase: KeptPhrase) => {
      const kept = phrase.stretched;
      // One cut short by an earlier Repeat is worked out again.
      if (kept?.rate === rate && (kept.ready || !kept.signal.aborted)) return kept.samples;
      const stretched: NonNullable<KeptPhrase["stretched"]> = { rate, signal: controller.signal, samples: stretchInSteps(joinSamples(phrase.samples), rate, controller.signal, phrase.sampleRate) };
      stretched.samples.then(() => { stretched.ready = true; }, () => {});
      phrase.stretched = stretched;
      return stretched.samples;
    };
    void (async () => {
      // Each phrase is made faster while the one before it plays.
      let next = prepare(phrases[0]);
      for (let i = 0; i < phrases.length; i++) {
        const samples = await next;
        if (i + 1 < phrases.length) next = prepare(phrases[i + 1]);
        const buffer = bufferOf(audio, samples, phrases[i].sampleRate);
        if (!buffer) continue;
        await playThrough(audio, controller.signal, (analyser, started) => playAudioBuffer(buffer, audio, analyser, controller.signal, started));
      }
    })().catch(() => {}).finally(() => { if (replay.current === controller) replay.current = null; });
    return true;
  };
  const synthesize = async (text: string, signal: AbortSignal, audio: AudioContext, kind:'reply'|'status'='reply') => {
    const trace=profiling.current?profiler.current!.current:undefined;
    const mark=(name:string,detail?:Record<string,number|string|boolean>,at?:number)=>{if(trace)profiler.current!.mark(kind+'_'+name,detail,trace,at);};
    mark('tts_request');
    // The previous cancelled request may still be releasing Breeze's GPU lock.
    let response: Response;
    const deadline = Date.now() + 15000;
    do {
      signal.throwIfAborted();
      response = await fetch(`/api/sessions/${sessionId}/voice/speech`, {
        method: "POST", headers: { "Content-Type": "application/json", "Accept": await opusSupported() ? "audio/ogg, audio/pcm;q=0.9" : "audio/pcm" },
        body: JSON.stringify({ text }), signal,
      });
      if (response.ok) break;
      mark('tts_retry',{http:response.status});
      const failure = await response.json().catch(() => ({}));
      // Older portal processes wrap Breeze's busy response in HTTP 502. This
      // also permits updating the UI without restarting an active session.
      const busy = response.status === 409 && failure.error === "Breeze is finishing another request"
        || response.status === 502 && /^Breeze returned HTTP 409/.test(failure.error || "");
      if (!busy || Date.now() >= deadline) throw new Error(failure.error || t("Speech generation failed"));
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 500);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
    } while (true);
    mark('tts_headers',{serverTiming:response.headers.get('server-timing')??''});
    let body=response.body;
    // Ogg/Opus (asked for above where WebCodecs decodes it) becomes 48 kHz s16le here; the rest plays it as PCM.
    const ogg = !!body && (response.headers.get("content-type") ?? "").startsWith("audio/ogg");
    if (ogg) body = oggOpusToPcm(body!);
    if(body&&trace){let first=true;body=body.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>,Uint8Array<ArrayBuffer>>({transform(chunk,controller){if(first&&chunk.length){first=false;mark('first_bytes');}controller.enqueue(chunk);}}));}
    let buffer: AudioBuffer | undefined;
    let stream: Awaited<ReturnType<typeof preparePcmSpeech>> | undefined;
    // Kept for Repeat once it is played; a phrase prepared and then cancelled was never heard.
    const phrase = { samples: [] as Float32Array[], sampleRate: 24000 };
    const options = { rate: speed.current, ...(kind === 'reply' ? { record: (samples: Float32Array) => { phrase.samples.push(samples); } } : {}) };
    if (ogg || response.headers.get("content-type")?.startsWith("audio/pcm")) {
      const rate = ogg ? OPUS_RATE : Number(response.headers.get("x-sample-rate"));
      if ((rate !== 24000 && rate !== 48000) || !body) throw new Error(t("Unsupported speech stream"));
      phrase.sampleRate = rate; Object.assign(options, { sampleRate: rate });
      if (!sequential.current && response.headers.get("x-voice-streaming") === "true") stream = await preparePcmSpeech(body!, audio, signal, options);
      else buffer = await readPcmStream(body!, audio, signal, options);
    } else {
      const bytes = await new Response(body).arrayBuffer(); signal.throwIfAborted();
      const decoded = await audio.decodeAudioData(bytes); signal.throwIfAborted();
      const samples = decoded.getChannelData(0).slice();
      phrase.sampleRate = decoded.sampleRate; options.record?.(samples);
      buffer = options.rate === 1 ? decoded : bufferOf(audio, stretch(samples, options.rate, decoded.sampleRate), decoded.sampleRate);
      if (!buffer) throw new Error(t("Speech generation returned no audio"));
    }
    mark('audio_ready');
    const play = async (playbackSignal: AbortSignal) => {
      playbackSignal.throwIfAborted();
      // A new reply takes over from one being repeated.
      replay.current?.abort(); replay.current = null;
      if (kind === 'reply') {
        const kept = replyAudio.current;
        kept.push(phrase);
        let total = kept.reduce((n, p) => n + seconds(p), 0);
        while (kept.length > 1 && total > REPEAT_SECONDS) total -= seconds(kept.shift()!);
        setCanRepeat(true);
      }
      await playThrough(audio, playbackSignal, (analyser, started) => stream ? stream.play(analyser, started) : playAudioBuffer(buffer!, audio, analyser, playbackSignal, started), scheduledAt => {
        mark('playback_scheduled');
        const outputMs=(audio.baseLatency+(audio.outputLatency||0))*1000;
        mark('playback_estimate',{outputLatencyMs:outputMs},performance.now()+Math.max(0,scheduledAt-audio.currentTime)*1000+outputMs);
      });
    };
    return Object.assign(play, { completed: stream?.completed });
  };
  const start = async (resuming = false) => {
    if (voice.current || starting) { stop(); return; }
    const version = ++epoch.current;
    const current = () => mounted.current && epoch.current === version;
    setStarting(true); setError(""); setMuted(false); mutedRef.current = false;
    // From the moment it is turned on: a reload while it connects brings it back too.
    session.set('voiceActive', sessionId);
    // Alongside the rest of starting, which it ends if another tab has voice mode on.
    void claim(version, resuming).then(ok => { if (!ok && epoch.current === version) stop(); });
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error(t("Microphone access requires HTTPS or localhost."));
      const sound = new AudioContext(); soundContext.current = sound;
      // Started by a click, audio is allowed and only slow to start — a
      // Bluetooth headset can take a while — so it gets longer to do it.
      await Promise.race([sound.resume(), new Promise(resolve => setTimeout(resolve, resuming ? 300 : 2000))]);
      if (!current()) return;
      if (sound.state !== "running") {
        // Started without a click — after a reload — so the browser holds audio
        // back until the page is touched. Not every event counts: a touch lets
        // audio start when the finger is lifted, not when it lands, and Escape
        // never does. So each one tries, and the wait is over once one has and
        // audio is running. The click that started it already counts.
        setWaitingForTap(true);
        await new Promise<void>(resolve => {
          const events = ["pointerdown", "pointerup", "touchend", "click", "keydown", "keyup"] as const;
          let touched = !resuming;
          const done = () => {
            if (current() && !(touched && sound.state === "running")) return;
            for (const name of events) window.removeEventListener(name, attempt, true);
            sound.removeEventListener("statechange", done);
            clearInterval(check);
            resolve();
          };
          const attempt = () => { touched = true; void sound.resume().then(done, () => {}); };
          for (const name of events) window.addEventListener(name, attempt, true);
          sound.addEventListener("statechange", done);
          // Ended or left while waiting: stop listening.
          const check = setInterval(done, 1000);
        });
        if (mounted.current && current()) setWaitingForTap(false);
        if (!current()) return;
      }
      // 2026-10-19: the rate now follows the engine (`speechSampleRate` from
      // GET /api/voice: 48000 for VoxCPM2, 24000 otherwise) - same reason as
      // below, a context at the stream's own rate resamples nothing. A whole
      // WAV phrase at another rate (Kokoro) is one buffer, resampled once.
      // 2026-10-12: forced to 24000 to match the TTS PCM streams' own rate
      // (pcm-stream.ts's bufferOf() always builds buffers at 24000 - every
      // engine behind /voice/speech, Chatterbox and OmniVoice both, sends
      // audio/pcm at X-Sample-Rate: 24000). Without this, the context ran at
      // the device's native output rate (commonly 48000, sometimes 44100),
      // and preparePcmSpeech() in pcm-stream.ts builds a SEPARATE AudioBuffer
      // per network read of the streamed response (confirmed directly
      // against forgeloop-ai's real TTS backends: 265-378 separate reads for
      // a single ~20s reply, not one continuous buffer) - each one
      // independently resampled by the browser on playback since buffer rate
      // != context rate. Resampling many small buffers in isolation (no
      // shared filter context across the cut points) introduces a boundary
      // artifact at every seam; with hundreds of seams per reply this reads
      // as continuous crackling/static for the whole reply, not a few
      // isolated clicks - matching a real report of exactly that ("every
      // reply, start to finish"). Forcing the context to 24000 makes every
      // buffer's rate match the context's rate exactly, so Web Audio does no
      // resampling at all, regardless of how many small buffers the network
      // stream gets split into. Shared with MicVAD below (`audioContext:
      // audio`) - vad-web's own API is designed to accept an arbitrary
      // pre-existing context (every browser already hands it one at an
      // unpredictable native rate), so it does its own internal resampling
      // to whatever Silero VAD needs; this is not expected to change mic
      // detection behavior, but wasn't re-verified against a real
      // microphone from here.
      const audio = new AudioContext({ sampleRate: speechRate.current }); context.current = audio;
      await audio.resume();
      if (!current()) return;
      const mic = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      if (!current()) { mic.getTracks().forEach(track => track.stop()); return; }
      stream.current = mic;
      // What the VAD and the recognizer hear: the microphone through the noise model, or the microphone where there is none.
      const heard = cleaned.current = await suppressNoise(mic, noiseModel.current);
      if (!current()) { heard.close(); return; }
      if(managed.current){
        const lease=crypto.randomUUID();connection.current=lease;
        await connectVoice(lease,true);
        if(!current())return;
        heartbeat.current=setInterval(()=>{void connectVoice(lease,true).catch(e=>{if(current()){setError(e.message);stop();}});},25000);
      }
      const detectorModule = await import("@ricky0123/vad-web");
      if (!current()) return;
      const showPreview = (text: string) => { if (current()) { setTranscript(text); voice.current?.heard(text); if (!text) setSpeaker(undefined); } };
      const plain = new LiveTranscription(async (samples, signal) => {
        const trace=profiling.current?profiler.current!.current:undefined;
        const started=performance.now();if(trace)profiler.current!.mark('stt_request',{audioMs:samples.length/16},trace);
        let result: { text: string; serverTiming: string; speaker?: RtcSpeaker };
        try {
          result = await api.transcribe(sessionId, samples, signal);
        } catch (e) {
          if(trace)profiler.current!.mark('stt_result',{requestMs:performance.now()-started,serverTiming:'',ok:false},trace);
          throw e;
        }
        if(trace)profiler.current!.mark('stt_result',{requestMs:performance.now()-started,serverTiming:result.serverTiming,ok:true},trace);
        if (current() && result.speaker) { setSpeaker(result.speaker); speakerNow.current = result.speaker; }
        return result.text;
      }, showPreview, !sequential.current);
      const live = new StreamedTranscription(plain, () => rtcStt.current, showPreview, speaker => { if (current()) { setSpeaker(speaker); speakerNow.current = speaker; } });
      transcription.current = live;
      const controller = new HandsFreeVoice({
        statusSpeech: statusSpeech.current,
        language: () => spokenLanguage.current,
        sequential: sequential.current,
        sentenceChunks: sentenceChunks.current,
        mergeReplies: mergeReplies.current,
        ttsPrefetch: ttsPrefetch.current,
        transcribe: async (samples, signal) => {
          speakerNow.current = undefined;
          const result = await live.finish(samples, signal);
          profileMark('transcript_ready');
          // Empty text is what hands-free treats as noise: nothing is sent and an interrupted reply is spoken on.
          return ignoresUnknown(unknownVoicesNow.current, speakerNow.current) ? "" : result;
        },
        send: async text => {
          profileSeq.current=eventSeq.current;profileMark('send'); cue("sent");
          // The pictures waiting now go with it, and only they leave the tray:
          // at once, as from the message box, and back if it does not get there.
          const images = pending.get(sessionId);
          if (images.length) pending.set(sessionId, []);
          const steer = steering.current && latest.current.running;
          // Whose voice it was, for the agent to greet by name or to ask who they are: see server/src/pi/voice-speaker.ts.
          const verdict = speakerForPrompt(speakerNow.current);
          // What is said next answers this, so Repeat is for that — from now, as
          // its first words may be spoken before the send returns.
          const before = replyAudio.current;
          replyAudio.current = []; setCanRepeat(false);
          try {
            await latest.current.onSend(text, { voice: true, ...(verdict ? { speaker: verdict } : {}), ...(images.length ? { images } : {}), ...(steer ? { steer: true } : {}) });
            // The prompt has set the conversation's language now: ask for it, without waiting for the answer.
            void api.voiceLanguage(sessionId).then(lang => { spokenLanguage.current = lang; });
          } catch (e) {
            if (images.length) pending.set(sessionId, [...images, ...pending.get(sessionId)]);
            if (!replyAudio.current.length) { replyAudio.current = before; setCanRepeat(before.length > 0); }
            throw e;
          }
        },
        abort: () => latest.current.onAbort(),
        command: text => asksToRepeat(text) && repeatReply(),
        couldBeCommand: couldAskToRepeat,
        steering: () => steering.current,
        agentRunning: () => latest.current.running,
        synthesize: (text, signal,kind) => synthesize(text, signal, audio,kind),
        trace: profileMark,
        phase: value => { if (current()) setPhase(value); },
        error: message => { if (current()) {setError(message);profiler.current?.close('error');} },
      }, latest.current.items);
      voice.current = controller;
      void api.voiceLanguage(sessionId).then(lang => { spokenLanguage.current = lang; });
      controller.setCompacting(latest.current.compacting);
      // Speech that is for the assistant: what it is told stops the reply, and is recorded as a request.
      const confirmSpeech = () => {
        // Talking over a repeated reply stops it, as it does a new one.
        replay.current?.abort();
        if (pushToTalk.current) return;
        setError(""); if (latest.current.compacting) live.discard(); else live.confirm(); controller.speechStart();
        clearTimeout(maxTurn.current);
        maxTurn.current = setTimeout(async () => {
          if (!current() || !vad.current) return;
          // Bound recording size; keep the same mic stream while submitting
          // the segment and automatically listening for the continuation.
          const active = vad.current;
          try { await active.pause(); if (current()) await active.start(); }
          catch (e) { if (current()) { setError((e as Error).message); stop(); } }
        }, 60000);
      };
      // The speech went on with the reply turned down: a person talking over it.
      const bargeIn = () => {
        echoProbe.current.stop(); confirmSpeech();
        // The reply is stopped by now; whatever plays next is turned up again.
        setTimeout(() => duck(false), 250);
      };
      // The speech went away with the reply turned down: it was the reply's own echo. Turned up again, and the rest of the segment ignored.
      const dismissEcho = () => {
        echoProbe.current.stop(); duck(false); echoSegment.current = true; live.discard();
      };
      const detector = await detectorModule.MicVAD.new({
        model: "v5", audioContext: audio, startOnLoad: false,
        baseAssetPath: "/voice-assets/", onnxWASMBasePath: "/voice-assets/",
        ortConfig: ort => { ort.env.wasm.numThreads = 1; },
        getStream: async () => heard.stream,
        pauseStream: async () => {},
        resumeStream: async () => (inputWatch.current.raw ? mic : heard.stream),
        ...vadSettings.current,
        submitUserSpeechOnPause: true,
        onSpeechStart: () => {
          // A new segment starts clean: nothing left over from an earlier one may decide it (a probe never finished, an echo flag never cleared, the reply still turned down).
          if (current() && !pushToTalk.current) { if (echoProbe.current.active) echoProbe.current.stop(); echoSegment.current = false; if (!playGain.current && ducked.current) duck(false); }
          if (current() && !pushToTalk.current && !mutedRef.current && !latest.current.compacting) {if(profiling.current)profiler.current!.begin();live.begin();} },
        onVADMisfire: () => { if (current() && !pushToTalk.current) {if (echoProbe.current.active) { echoProbe.current.stop(); duck(false); } live.discard();if(profiling.current)profiler.current!.close('vad_misfire');} },
        onFrameProcessed: (probabilities, frame) => {
          { const w = inputWatch.current, now = performance.now(); w.lastFrame = now; let peak = 0; for (let i = 0; i < frame.length; i++) { const a = Math.abs(frame[i]); if (a > peak) peak = a; } if (peak > 1e-6) w.liveAt = now; }
          if (pushToTalk.current) {
            // Only what is said while the button or Space is held counts.
            const press = held.current;
            if (!current() || !press) { levels.current.input = 0; return; }
            press.frames.push(frame.slice());
            if (!press.releasing) press.heldFrames = press.frames.length;
            press.speech = Math.max(press.speech, probabilities.isSpeech);
            if (!latest.current.compacting) live.frame(probabilities.isSpeech, frame);
            levels.current.input = Math.min(1, Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length) * 7);
            return;
          }
          if (echoProbe.current.active) {
            const verdict = echoProbe.current.frame(performance.now(), probabilities.isSpeech);
            if (verdict === "person") bargeIn(); else if (verdict === "echo") dismissEcho();
          }
          if(current()&&!mutedRef.current&&profiling.current&&probabilities.isSpeech>=0.35)profiler.current!.lastSpeech();
          if (current() && !mutedRef.current && !latest.current.compacting) live.frame(probabilities.isSpeech, frame);
          if (current() && !mutedRef.current) levels.current.input = Math.min(1, Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length) * 7);
        },
        onSpeechRealStart: () => {
          if (!current() || mutedRef.current) return;
          // The level is only believed while a reply is really playing: with no playback node it is a stale reading, and treating it as a reply made every later turn a probe that could throw the speaker away.
          if (!playGain.current) levels.current.output = 0;
          if (!pushToTalk.current && !latest.current.compacting && levels.current.output >= 0.04) {
            // A reply is playing: turn it down and see whether the speech goes on without it, see echo-guard.ts.
            echoProbe.current.start(performance.now(), settleFor(playGain.current?.context && (playGain.current.context as AudioContext).outputLatency)); duck(true); return;
          }
          confirmSpeech();
        },
        onSpeechEnd: samples => {
          if (pushToTalk.current) return;
          clearTimeout(maxTurn.current);
          if (echoProbe.current.active) {
            // Over before the quiet could say what it was.
            if (echoProbe.current.end() === "person") bargeIn(); else { dismissEcho(); echoSegment.current = false; return; }
          }
          if (echoSegment.current) { echoSegment.current = false; return; }
          if (current() && !mutedRef.current) { if (!latest.current.compacting) {profileMark('endpoint');live.end(samples);} controller.speechEnd(samples); }
        },
      });
      if (!current()) { await detector.destroy(); return; }
      vad.current = detector;
      for (const track of mic.getTracks()) track.onended = () => {
        if (current()) { setError(t("Microphone disconnected. Reconnect it and turn the mic on again.")); stop(); }
      };
      await detector.start();
      if (!current()) return;
      // Input watchdog. Nothing else notices when the microphone path dies in the middle of a session: the orb stays flat, the VAD hears nothing and the page says "Listening".
      // Two ways it dies, told apart here: the VAD frames stop (its context or worklet stalled), or they go on as digital silence (the noise model's node died, or the microphone itself did).
      const rawProbe = audio.createAnalyser(); rawProbe.fftSize = 1024;
      try { audio.createMediaStreamSource(mic).connect(rawProbe); } catch { /* no probe: the cleaned path is judged by frames alone */ }
      const rawBuf = new Float32Array(rawProbe.fftSize);
      inputWatch.current.lastFrame = inputWatch.current.liveAt = performance.now();
      let restarting = false;
      const restartDetector = async (why: string, mark: () => void) => {
        if (restarting) return; restarting = true;
        console.warn(`voice: ${why}`);
        try {
          if (audio.state !== "running") await audio.resume();
          mark();
          const d = vad.current;
          if (d && d === detector) { await d.pause(); await d.start(); }
        } catch (e) { console.warn("voice: restarting the detector failed", e); }
        finally { restarting = false; }
      };
      clearInterval(inputWatch.current.timer);
      inputWatch.current.timer = setInterval(() => {
        const w = inputWatch.current, now = performance.now();
        if (!current() || pushToTalk.current || mutedRef.current || latest.current.compacting || document.hidden || vad.current !== detector) { w.lastFrame = w.liveAt = now; return; }
        if (now - w.lastFrame > 3000) { void restartDetector(`no VAD frames for 3 s (context ${audio.state}), restarting the detector`, () => { w.lastFrame = now; }); return; }
        if (now - w.liveAt > 8000 && !w.raw && heard.stream !== mic) {
          rawProbe.getFloatTimeDomainData(rawBuf);
          const rawPeak = rawBuf.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
          if (rawPeak > 1e-5) {
            // The microphone has sound and what the noise model passes on has none: its node died. Use the microphone itself from here on.
            void restartDetector("the noise model's output went silent while the microphone has sound, switching to the raw microphone", () => {
              w.raw = true; w.liveAt = now;
              const r = rtcStt.current; if (r) { rtcStt.current = undefined; r.close(); reconnectRtc.current(); }
            });
          } else if (now - w.liveAt > 8000) { w.liveAt = now; console.warn("voice: the microphone itself is silent"); }
        }
      }, 1000);
      // Streaming recognition comes up beside the plain upload, which stays the way every utterance goes until it is up.
      if (rtcEnabled.current) {
        const connectRtc = (delay: number) => {
          if (!current()) return;
          const rtc = new RtcStt(offer => api.rtcOffer(sessionId, offer), {
            interim: live.interim,
            state: up => { if (!up && current() && rtcStt.current === rtc) { rtc.close(); rtcStt.current = undefined; setTimeout(() => connectRtc(Math.min(delay * 2, 30000)), delay); } },
          });
          rtcStt.current = rtc;
          rtc.connect(inputWatch.current.raw ? mic : heard.stream).catch(() => { if (rtcStt.current === rtc) { rtc.close(); rtcStt.current = undefined; if (current()) setTimeout(() => connectRtc(Math.min(delay * 2, 30000)), delay); } });
        };
        connectRtc(2000);
        reconnectRtc.current = () => connectRtc(0);
      }
      // With push-to-talk the microphone is open only while held.
      if (pushToTalk.current) mic.getTracks().forEach(track => { track.enabled = false; });
      setEnabled(true); setStarting(false); cue("start");
    } catch (e) {
      if (current()) { setError(micError(e)); stop(); }
    }
  };

  // Start and end voice mode from the keyboard, from the chat as well: the one
  // voice shortcut that works with the message box focused, as it has a modifier.
  const bindings = useKeybindings();
  const toggleKey = useRef({ binding: bindings["voice.toggle"], on: false, start, end: endMode });
  toggleKey.current = { binding: bindings["voice.toggle"], on: enabled || starting || duplexActive,
    start: async () => { duplexToggleRef.current?.(); },
    end: () => { if (duplexActiveRef.current) window.dispatchEvent(new CustomEvent("yulify:end-voice", { detail: { sessionId } })); else endMode(); },
  };
  useEffect(() => {
    if (!available) return;
    const down = (e: KeyboardEvent) => {
      const { binding, on, start, end } = toggleKey.current;
      if (e.defaultPrevented || e.repeat || !matches(binding, e) || document.querySelector('[aria-modal="true"]')) return;
      const b = binding!;
      if (!(b.ctrl || b.alt || b.meta) && (e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
      e.preventDefault(); e.stopPropagation();
      if (on) end(); else void start();
    };
    window.addEventListener("keydown", down, true);
    return () => window.removeEventListener("keydown", down, true);
  }, [available]);

  if (!available) return null;
  return <>
    {profileOpen&&createPortal(<VoiceProfile profiler={profiler.current!} onClose={()=>{setProfileOpen(false);profiler.current!.close('disabled');}}/>,document.body)}

    {(starting || enabled || duplexActive) && stageTarget && createPortal(
      <VoiceStage legacyControls={!duplexActive} sessionId={sessionId} folder={folder} workPhase={work} canvasOpen={canvasOpen} onCanvasMinimize={onCanvasMinimize} onCanvasToggle={onCanvasToggle} title={duplexActive ? `${title} · PersonaPlex full duplex` : sequentialMode ? `${title} · ${sentenceMode ? (prefetchMode ? t("Sentence pipeline · buffered audio") : t("Sentence chunks · buffered audio")) : t("Sequential baseline")}` : comparison ? `${title} · ${t("Streaming pipeline")}` : title} phase={duplexActive ? (duplexState === "connected" ? (duplexHearing ? "Hearing you" : duplexActivity === "transcribing" ? "Transcribing" : duplexActivity === "thinking" || duplexActivity === "tool" ? "Thinking" : duplexActivity === "speaking" ? "Speaking" : "Listening") : "Thinking") : phase} starting={starting || (duplexActive && duplexState !== "connected")} muted={duplexActive ? duplexMuted : muted} speaking={duplexActive ? duplexActivity === "speaking" : speaking} musicPlaying={musicPlaying}
        browserAvailable={browserAvailable} browserActivity={browserActivity} terminalActivity={terminalActivity} toolEvents={toolEvents} sounds={sounds} onSounds={toggleSounds} onCue={cue}
        microphoneTools={duplexActive ? <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-fg-muted"><span>{duplexCapture.label}{duplexCapture.muted ? " · muted" : ""}</span><meter aria-label="Microphone input level" min={0} max={1} value={duplexCapture.level} /><button type="button" className="rounded border border-line px-2 py-1" onClick={() => void duplexReconnectRef.current?.()}>Mikrofonu yeniden bağla</button></div> : undefined}
        levels={levels} transcript={duplexActive ? duplexCaption : transcript} speaker={duplexActive ? undefined : speaker} error={duplexActive ? duplexError : error} onMute={duplexActive ? () => duplexMuteRef.current?.() : toggleMute} onEnd={duplexActive ? () => window.dispatchEvent(new CustomEvent("yulify:end-voice", { detail: { sessionId } })) : endMode} waitingForTap={waitingForTap}
        items={items} running={running || (duplexActive && duplexActivity !== "listening")} onStop={() => { if (duplexActive) window.dispatchEvent(new CustomEvent("yulify:interrupt-voice", { detail: { sessionId } })); else void latest.current.onAbort().catch(e => setError((e as Error).message)); }}
        attachments={attachments} onAddPictures={files => { void addPictures(files); }} onRemovePicture={id => pending.set(sessionId, pending.get(sessionId).filter(a => a.id !== id))}
        canRepeat={canRepeat} onRepeat={() => { repeatReply(); }}
        rate={rate} onRate={value => { local.set('voiceRate', String(value)); setRate(value); }}
        steer={steer} onSteer={value => { local.set('voiceSteer', value ? 'on' : 'off'); setSteer(value); }}
        unknownVoices={unknownVoices} onUnknownVoices={mode => { local.set('voiceOnlyOwner', mode === 'all' ? 'off' : mode === 'enrolled' ? 'on' : 'ask'); setUnknownVoices(mode); }}
        ptt={duplexActive ? false : ptt} onPtt={value => { void choosePtt(value); }} holding={holding} onHold={hold} />, stageTarget,
    )}
    <div className="relative flex items-center gap-1">
      <button type="button" className="prompt-action" aria-label={t("Profile voice latency")} title={t("Profile voice latency")} aria-pressed={profileOpen} onClick={()=>{setProfileOpen(v=>!v);if(profileOpen)profiler.current!.close('disabled');}}><LuGauge/></button>
      <MiniCpmDuplexControl onToggleControl={control => { duplexToggleRef.current = control; }} onActivity={setDuplexActivity} sessionId={sessionId} disabled={enabled || starting} onModeChange={active => { duplexActiveRef.current = active; setDuplexActive(active); if (!active) { setDuplexMuted(false); setDuplexCaption(""); } }} onStatus={(next, caption) => { setDuplexState(next); setDuplexCaption(caption); }} onMuteControl={control => { duplexMuteRef.current = control; if (!control) setDuplexMuted(false); }} onMutedChange={setDuplexMuted} onInputLevel={value => { levels.current.input = value; setDuplexHearing(value > 0.04); }} onCaptureStatus={setDuplexCapture} onError={setDuplexError} onReconnectControl={control => { duplexReconnectRef.current = control; }} />
      {error && !enabled && !starting && <p role="alert" className="absolute bottom-full right-0 mb-3 w-64 rounded-xl border border-line bg-surface p-3 text-xs text-danger shadow-pop">{error}</p>}
      <details className="relative">
        <summary className="prompt-action list-none cursor-pointer" aria-label="Diğer ses seçenekleri" title="Diğer ses seçenekleri">⋯</summary>
        <div className="absolute bottom-full right-0 z-20 mb-2 rounded-xl border border-line bg-surface p-2 shadow-pop">
          <button ref={startButton} type="button" disabled={duplexActive} onClick={() => { void start(); }} aria-label="Klasik sesli mod" title="Klasik sesli mod" className="flex items-center gap-2 whitespace-nowrap rounded px-3 py-2 text-sm">
            {starting ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuAudioLines aria-hidden />} Klasik sesli mod
          </button>
        </div>
      </details>
    </div>
  </>;
}
