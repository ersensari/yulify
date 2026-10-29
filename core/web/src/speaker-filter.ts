import type { RtcSpeaker } from "./rtc-stt";

/**
 * Voice mode can ignore voices that are not enrolled ("Only enrolled voices", on by default).
 *
 * An utterance is dropped only when the portal is SURE it is a stranger: the verdict exists, was reached on a clip long
 * enough to carry weight (`reliable`) and matched none of the enrolled voices. No verdict (identification off, nobody
 * enrolled, the service down, a clip too short to judge) always lets the speech through, so a missing piece never
 * silences the owner; the cost is that a very short stranger's word can still get in.
 */
export const ignoredVoice = (filterOn: boolean, speaker: RtcSpeaker | undefined): boolean =>
  filterOn && !!speaker && speaker.reliable && !speaker.matched;

/**
 * What to do with voices that are not enrolled: hear them (`all`), ignore them (`enrolled`, as above), or let
 * them through and have the agent say it does not know them and ask who they are (`ask`, the default). Only
 * `enrolled` ever drops speech; a stranger the agent hears is told to be treated as a guest (server: voice-speaker.ts).
 */
export type UnknownVoices = "all" | "enrolled" | "ask";

/** The saved choice. `voiceOnlyOwner` was on/off before `ask` existed: "off" is still "all", and a stored "on" still means "enrolled". */
export const unknownVoicesFrom = (saved: string | null | undefined): UnknownVoices =>
  saved === "off" ? "all" : saved === "on" ? "enrolled" : "ask";

export const ignoresUnknown = (mode: UnknownVoices, speaker: RtcSpeaker | undefined): boolean =>
  ignoredVoice(mode === "enrolled", speaker);

/** What goes with the prompt: only a verdict that is reliable enough to act on. */
export const speakerForPrompt = (speaker: RtcSpeaker | undefined): { name: string | null; matched: boolean; reliable: boolean; clip?: string } | undefined =>
  speaker && speaker.reliable ? { name: speaker.name, matched: speaker.matched, reliable: true, ...(speaker.clip ? { clip: speaker.clip } : {}) } : undefined;
