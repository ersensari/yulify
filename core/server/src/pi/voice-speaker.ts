import { getDefaultReportTo } from "../db.js";
import { cleanName, hasPrimary, primaryName, senderFraming, type PersonRow } from "../people.js";
import { neutralise } from "../channels/framing.js";

/**
 * Who is speaking, for a message that came in by voice.
 *
 * The verdict is the speech service's (forgeloop-ai-speech, voice-stt/speaker.ts) and rides along with the
 * transcript through the browser, which hands it back with the prompt. It is advisory in both directions and
 * checked here: a name is cleaned like any name the portal shows the model, a clip id must look like one, and a
 * voice that is recognised is trusted only as far as its name is the primary user's. Anybody else the service
 * knows is a guest, so enrolling a stranger (enroll_voice) gives them a name to be greeted by, never more access.
 */
export interface SpokenBy {
  name: string | null;
  matched: boolean;
  reliable: boolean;
  clip?: string;
}

/** What the browser sent, or nothing: anything that is not the shape of a verdict is no verdict. */
export function parseSpokenBy(raw: unknown): SpokenBy | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.matched !== "boolean" || typeof o.reliable !== "boolean") return undefined;
  const name = typeof o.name === "string" ? cleanName(o.name) : "";
  const clip = typeof o.clip === "string" && /^[a-f0-9]{8,32}$/.test(o.clip) ? o.clip : undefined;
  return { name: name || null, matched: o.matched, reliable: o.reliable, ...(clip ? { clip } : {}) };
}

const isPrimaryVoice = (name: string) => !hasPrimary() || name.toLowerCase() === primaryName().toLowerCase();

/** The block that tells the agent who spoke, or "" when the portal has nothing to say (no verdict, a clip too short to judge). */
export function speakerNote(by: SpokenBy | undefined): string {
  if (!by || !by.reliable) return "";
  const primary = primaryName();
  if (by.matched && by.name) {
    if (isPrimaryVoice(by.name)) {
      return `Voice recognised: ${by.name}. Greet and address them by name, naturally and not in every reply.`;
    }
    const guest: PersonRow = { key: `voice:${by.name}`, name: by.name, role: "guest", notes: "", first_seen: "", last_seen: null, announced_at: null, renamed: 0 };
    return `Voice recognised: ${by.name}, enrolled by voice.\n` +
      senderFraming(guest, primary, Boolean(getDefaultReportTo())) + `\nAddress them by name.`;
  }
  if (by.matched || !by.clip) return "";
  return [
    `This voice is not enrolled: the portal does not know who is speaking, and it is not ${primary}'s voice.`,
    `Until you know who they are, treat them as a guest: answer what they ask, run nothing for them, and do not volunteer what ${primary} is working on.`,
    `Say it plainly in your reply: you do not recognise this voice. Then ask who they are, so you can get to know them.`,
    `When they tell you their name, call the enroll_voice tool with that name and clip "${by.clip}", then greet them by name; from the next time you hear them the portal names them itself.`,
    `If the tool says it needs more speech, ask them to say a sentence or two, and call it again with the clip id of their next message.`,
    `If you asked already in this conversation and they did not give a name, do not ask again: help as a guest. Never enroll anyone under ${primary}'s name or a name already taken: the tool refuses it, and a voice that does not match is not ${primary}.`,
  ].join("\n");
}

/** The words of a spoken message with the speaker block in front, as a channel message has it. Unchanged when there is nothing to say. */
export function withSpeaker(message: string, by: SpokenBy | undefined): string {
  const note = speakerNote(by);
  return note ? `<speaker>\n${note}\n</speaker>\n\n${neutralise(message)}` : message;
}
