import { wav16 } from "./pcm.js";

export const RATE = 16000;

/** Who the voice in one utterance belongs to, as forgeloop-ai-speech's /v1/speakers/identify says it (opt-in, see speaker.ts). */
export interface Speaker {
  /** The best-scoring enrolled voice, whether or not it cleared the threshold. */
  name: string | null;
  score: number | null;
  /** The score reached the service's threshold: a verdict a caller may act on. */
  matched: boolean;
  /** The clip was long enough (>= ~2 s) for the verdict to carry weight. */
  reliable: boolean;
  /** An unmatched, reliable clip the speech service kept for enrolling: see the enroll_voice tool. */
  clip?: string;
}

export interface Transcript {
  text: string;
  /** The language Whisper decided on, as it names it ("tr", "en"). */
  language?: string;
  segments?: { text?: string; avg_logprob?: number; no_speech_prob?: number }[];
  /** Set only on a final transcript, and only where speaker identification is switched on. */
  speaker?: Speaker;
}
/** `final` marks the transcript of a whole utterance; interims are previews of a growing one and never identify a voice. */
export type Transcribe = (wav: Buffer, opts: { language?: string; signal: AbortSignal; final?: boolean }) => Promise<Transcript>;

/** What goes to the browser over the data channel. */
export type SttMessage =
  | { t: "interim"; id: string; text: string; language?: string }
  | { t: "final"; id: string; text: string; language?: string; speaker?: Speaker }
  | { t: "error"; id: string; error: string };

export interface SttOptions {
  /** How often an interim result may be asked for. */
  interimMs?: number;
  /** New audio needed since the last interim before another is asked for. */
  minNewMs?: number;
  /** The audio kept from before the start marker: the VAD's own pad plus RTP in flight. */
  preRollMs?: number;
  /** An interim looks at the end of a long utterance only; the final looks at all of it. */
  interimWindowMs?: number;
  /** How long the end marker waits for audio still on its way. */
  flushIdleMs?: number;
  flushMaxMs?: number;
  /** A language the person set: every request names it and none is left to detection. */
  language?: string;
  /**
   * The languages this person speaks. Whisper turns noise into a confident sentence in some other language (a
   * Japanese thank-you, a Russian "to be continued") with a good log-probability and no sign of silence, so a
   * transcript in a language outside this list is dropped, and such a guess never becomes the language the rest of
   * the utterance is locked to. Empty or absent: any language counts.
   */
  languages?: readonly string[];
}

/** Phrases Whisper writes for silence and noise; a transcript that is only one of these is not speech. */
const NOISE_PHRASES = new Set([
  // Left out on purpose: "thank you" and "you", which Whisper also writes for silence but which a person says
  // to an assistant; the browser's VAD is what keeps silence from getting here.
  "thanks for watching", "thank you for watching", "altyazı m.k.", "altyazı", "izlediğiniz için teşekkürler",
  "abone olmayı unutmayın", "subtitles by the amara.org community", "продолжение следует", "ご視聴ありがとうございました",
].map(normalize));
function normalize(s: string) { return s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ").trim(); }

/**
 * The text of a transcript with the segments Whisper itself doubts left out:
 * likely no speech and a poor log-probability together. Noise in a busy room
 * comes back as a confident-looking sentence otherwise.
 */
export function cleanTranscript(t: Transcript, languages?: readonly string[]): string {
  if (languages?.length && t.language && !languages.includes(t.language)) return "";
  const kept = t.segments?.length
    ? t.segments.filter(s => !((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -1)).map(s => s.text ?? "").join("").trim()
    : t.text.trim();
  // Noise sometimes comes back as punctuation alone (". .").
  if (!/[\p{L}\p{N}]/u.test(kept)) return "";
  // The same phrase twice is how a long noise tends to come back.
  return NOISE_PHRASES.has(normalize(kept).replace(/^(.+?)( \1)+$/u, "$1")) ? "" : kept;
}

/**
 * One listener's recognition. The browser's VAD says when an utterance starts
 * and ends (`start`/`end`); audio arrives all the time through `push`. While an
 * utterance runs, interim transcripts of what has been said so far go out;
 * `end` sends one transcript of all of it.
 *
 * The language is decided by the first interim results and is kept for the
 * rest of that utterance: the requests after it name the language instead of
 * having Whisper detect it again, which is both faster and steadier. The next
 * utterance starts open again, for someone who changes language between turns.
 */
export class SttSession {
  private readonly o: Required<Omit<SttOptions, "language" | "languages">> & Pick<SttOptions, "language" | "languages">;
  private ring: Int16Array[] = []; private ringSamples = 0;
  private utt: Int16Array[] | null = null; private uttSamples = 0;
  private id = ""; private gen = 0;
  private lang: string | undefined; private lastSeenLang: string | undefined;
  private requested = 0; private pending: AbortController | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastPush = 0; private lastInterim = "";
  private closed = false;

  constructor(private readonly transcribe: Transcribe, private readonly send: (m: SttMessage) => void, options: SttOptions = {}) {
    this.o = { interimMs: 600, minNewMs: 400, preRollMs: 1200, interimWindowMs: 25000, flushIdleMs: 60, flushMaxMs: 200, ...options };
  }

  get speaking() { return this.utt !== null; }
  get language() { return this.lang; }

  push(pcm: Int16Array) {
    if (this.closed || !pcm.length) return;
    this.lastPush = Date.now();
    if (this.utt) { this.utt.push(pcm); this.uttSamples += pcm.length; return; }
    this.ring.push(pcm); this.ringSamples += pcm.length;
    const keep = (this.o.preRollMs * RATE) / 1000;
    while (this.ring.length > 1 && this.ringSamples - this.ring[0].length >= keep) this.ringSamples -= this.ring.shift()!.length;
  }

  start(id: string) {
    if (this.closed) return;
    this.cancel();
    this.id = id; this.gen++; this.utt = this.ring; this.uttSamples = this.ringSamples; this.ring = []; this.ringSamples = 0;
    this.lang = this.o.language; this.lastSeenLang = undefined; this.requested = 0; this.lastInterim = "";
    this.timer = setInterval(() => this.tick(), this.o.interimMs);
  }

  /** The utterance is over: one transcript of all of it. */
  async end(id: string = this.id) {
    if (!this.utt || id !== this.id) return;
    const gen = this.gen, started = Date.now();
    // The marker can overtake the last audio packets: wait until none arrive for a moment.
    while (Date.now() - this.lastPush < this.o.flushIdleMs && Date.now() - started < this.o.flushMaxMs) await new Promise(r => setTimeout(r, 15));
    if (gen !== this.gen || !this.utt) return;
    clearInterval(this.timer); this.timer = undefined; this.pending?.abort(); this.pending = undefined;
    const audio = join(this.utt), language = this.lang;
    this.utt = null; this.uttSamples = 0;
    // Too short to be words: a click or a cough that got past the VAD.
    if (audio.length < RATE * 0.25) { this.send({ t: "final", id, text: "" }); return; }
    const ctl = new AbortController(); this.pending = ctl;
    try {
      const result = await this.transcribe(wav16(audio), { language, signal: ctl.signal, final: true });
      if (gen !== this.gen) return;
      this.send({ t: "final", id, text: cleanTranscript(result, this.o.languages), language: result.language ?? language, ...(result.speaker ? { speaker: result.speaker } : {}) });
    } catch (e) {
      if (gen !== this.gen) return;
      this.send({ t: "error", id, error: (e as Error).message });
    } finally { if (this.pending === ctl) this.pending = undefined; }
  }

  /** Drops the utterance in progress. */
  cancel() {
    this.gen++; clearInterval(this.timer); this.timer = undefined;
    this.pending?.abort(); this.pending = undefined; this.utt = null; this.uttSamples = 0;
  }

  close() { this.cancel(); this.closed = true; this.ring = []; }

  private tick() {
    if (!this.utt || this.pending || this.uttSamples - this.requested < (this.o.minNewMs * RATE) / 1000) return;
    void this.interim();
  }

  private async interim() {
    if (!this.utt) return;
    const gen = this.gen, all = join(this.utt), window = (this.o.interimWindowMs * RATE) / 1000;
    const audio = all.length > window ? all.subarray(all.length - window) : all;
    this.requested = this.uttSamples;
    const ctl = new AbortController(); this.pending = ctl;
    try {
      const result = await this.transcribe(wav16(audio), { language: this.lang, signal: ctl.signal });
      if (gen !== this.gen || ctl.signal.aborted) return;
      // Locked once two results in a row agree, so one odd guess on a short start does not decide it.
      if (!this.lang && result.language && (!this.o.languages?.length || this.o.languages.includes(result.language))) {
        if (result.language === this.lastSeenLang) this.lang = result.language;
        this.lastSeenLang = result.language;
      }
      const text = cleanTranscript(result, this.o.languages);
      if (text && text !== this.lastInterim) { this.lastInterim = text; this.send({ t: "interim", id: this.id, text, language: result.language }); }
    } catch { /* an interim is a preview; the final one reports a failure */ }
    finally { if (this.pending === ctl) this.pending = undefined; }
  }
}

function join(chunks: Int16Array[]): Int16Array {
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
