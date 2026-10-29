import { Type } from "typebox";
import { speakerIdUrl } from "../voice-stt/speaker.js";
import { fail, say } from "./tool-result.js";
import { voiceHeaders } from "../voice-auth.js";

/**
 * Teaching the portal a new voice.
 *
 * A message from a voice nobody enrolled carries a clip id (see voice-speaker.ts): the speech service kept that
 * utterance, and others like it from the same voice, for a few minutes. When the person says who they are the
 * agent calls this, and the service turns those clips into a voice profile under that name. The service refuses a
 * name that is taken, so a stranger cannot replace anybody's profile by claiming their name; and what a profile is
 * good for is a name to be greeted by, nothing else (voice-speaker.ts keeps every name but the primary user's a guest).
 */
const enrollUrl = () => speakerIdUrl()?.replace(/\/identify$/, "/enroll-clip");

export const enrollVoiceOn = () => Boolean(enrollUrl());

export function enrollVoiceTool() {
  return (pi: any): void => {
    pi.registerTool({
      name: "enroll_voice",
      label: "Learn a voice",
      description:
        "Remember the voice you are talking to under the name they gave you, so the portal recognises them from now on. " +
        "Only for a voice the message's speaker note says is not enrolled, with the clip id given there.",
      promptSnippet: "enroll_voice — remember a new voice under a name",
      parameters: Type.Object({
        name: Type.String({ description: "What they told you to call them. Not the primary user's name." }),
        clip: Type.String({ description: "The clip id from the speaker note of their latest message." }),
      }),
      async execute(_id: string, p: any) {
        const url = enrollUrl();
        if (!url) return fail("Voice enrolment is not switched on here.");
        const name = String(p.name ?? "").trim();
        const clip = String(p.clip ?? "").trim();
        if (!name || name.length > 64) return fail("Give a name of 1-64 characters.");
        if (!/^[a-f0-9]{8,32}$/.test(clip)) return fail("That is not a clip id: use the one in the speaker note of their message.");
        const form = new FormData();
        form.set("name", name);
        form.set("clip_id", clip);
        let res: Response;
        try {
          res = await fetch(url, { method: "POST", body: form, headers: voiceHeaders(), redirect: "error", signal: AbortSignal.timeout(15000) });
        } catch {
          return fail("The speech service did not answer. Say you could not learn their voice right now.");
        }
        const body = (await res.json().catch(() => ({}))) as { detail?: string; name?: string; seconds?: number };
        if (res.status === 409) return fail("That name is already taken by a voice the portal knows. Do not use it; ask what else they would like to be called.");
        if (res.status === 422) return fail(`${body.detail ?? "Too little speech."} Ask them to say a sentence or two, then call this again with the clip id of their next message.`);
        if (res.status === 404) return fail("That clip has expired. Ask them to say something again, then use the new clip id.");
        if (!res.ok) return fail(`Could not enroll the voice (HTTP ${res.status}).`);
        return say(`Learned ${body.name ?? name}'s voice from ${body.seconds ?? "?"} s of speech. From their next message the portal recognises them. Greet them by name now.`);
      },
    });
  };
}
