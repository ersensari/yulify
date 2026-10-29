import { LiveTranscription } from "./live-transcription";
import type { RtcSpeaker, RtcStt } from "./rtc-stt";

/**
 * LiveTranscription's interface with the portal's streaming recognition behind
 * it where that is connected. An utterance that starts while it is takes its
 * interim and final text from the portal; one that starts while it is not, or
 * whose streamed transcript fails, goes the way it always did: the plain
 * upload of the recording, with its own speculative interim requests.
 */
export class StreamedTranscription {
  private id: string | undefined;
  private ended = new WeakMap<Float32Array, string>();
  private previewId = "";

  constructor(
    private readonly inner: LiveTranscription,
    private readonly rtc: () => RtcStt | undefined,
    private readonly preview: (text: string) => void,
    /** Who spoke the utterance just finished, where the portal identifies voices; undefined when it has no verdict. */
    private readonly onSpeaker?: (speaker: RtcSpeaker | undefined) => void,
  ) {}

  /** Wired to the RtcStt's interim hook. */
  interim = (id: string, text: string) => { if (id === this.previewId) this.preview(text); };

  frame(probability: number, samples: Float32Array) { this.inner.frame(probability, samples); }

  begin() {
    const rtc = this.rtc();
    if (rtc?.ready) {
      this.id = this.previewId = crypto.randomUUID(); this.preview(""); rtc.start(this.id);
    } else { this.id = undefined; this.inner.begin(); }
  }

  confirm() { if (!this.id) this.inner.confirm(); }

  end(samples: Float32Array) {
    if (!this.id) { this.inner.end(samples); return; }
    this.ended.set(samples, this.id); this.rtc()?.end(this.id); this.id = undefined;
  }

  async finish(samples: Float32Array, signal: AbortSignal): Promise<string> {
    const id = this.ended.get(samples);
    if (!id) return this.inner.finish(samples, signal);
    this.ended.delete(samples);
    const rtc = this.rtc();
    if (rtc) {
      try { const result = await rtc.final(id, signal); this.onSpeaker?.(result.speaker); return result.text; }
      catch (e) { if (signal.aborted) throw e; /* anything else: the recording itself goes up instead */ }
    }
    return this.inner.finish(samples, signal);
  }

  discard() {
    if (this.id) { this.rtc()?.cancel(this.id); this.id = undefined; this.preview(""); }
    this.inner.discard();
  }

  reset() { this.discard(); this.inner.reset(); }
}
