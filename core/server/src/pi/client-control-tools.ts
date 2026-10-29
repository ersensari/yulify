import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestClientControl } from "../client-controls.js";

export const CLIENT_CONTROL_RULE = "You can control this chat's voice mode and music player with end_voice_conversation and control_music_player. When the user clearly asks to finish or close the live voice conversation (for example, 'teşekkür ederim, kapatabilirsin', 'konuşmayı bitir' or 'we are done, you can close'), call end_voice_conversation; it ends voice mode, not the app or stored chat, and the native app resumes its enabled wake-word listener. A bare thank-you alone need not end the conversation. Give at most a brief farewell before the call and do not start more speech after success. For explicit user requests to play, pause, stop, replay or seek the existing song, call control_music_player; stop pauses and rewinds, replay starts from the beginning, play resumes. Use status if the target is unclear. Never regenerate music to perform playback control, and never start it merely because generation finished or the chat opened. A blocked/unavailable/error result is not success; report it briefly and do not automatically retry an unacknowledged play/replay. If the microphone is paused during music, playback commands must come from typed input or player controls until it is resumed.";
export function clientControlTools(sessionId: string) {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt + "\n\n" + CLIENT_CONTROL_RULE }));
    pi.registerTool({
      name: "end_voice_conversation", label: "End voice conversation",
      description: "End the current chat's active voice/orb conversation when the user asks to finish. Keeps the app and saved chat open; native clients release the microphone back to enabled wake-word listening. Only a live client acknowledgement counts as success.",
      parameters: Type.Object({}),
      execute: async (_id, _p, signal) => {
        const result = await requestClientControl(sessionId, { target: "voice", action: "end" }, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
    pi.registerTool({
      name: "control_music_player", label: "Control music player",
      description: "Control an existing music player in this chat on explicit request. play resumes; pause keeps position; stop pauses and rewinds; replay rewinds and plays; seek changes seconds; status reads current state. Omit job_id to target the playing or most recently used song. Does not generate a new song or change autoplay preferences.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("play"), Type.Literal("pause"), Type.Literal("stop"), Type.Literal("replay"), Type.Literal("seek"), Type.Literal("status")]),
        job_id: Type.Optional(Type.String({ pattern: "^[a-f0-9]{32}$" })),
        seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 86400 })),
      }),
      execute: async (_id, p, signal) => {
        if (p.action === "seek" && p.seconds === undefined) throw new Error("seconds is required for seek");
        const result = await requestClientControl(sessionId, { target: "music", action: p.action, jobId: p.job_id, seconds: p.seconds }, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
  };
}
