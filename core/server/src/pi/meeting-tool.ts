import { Type } from "typebox";
import path from "node:path";
import fs from "node:fs";
import { getSession } from "../db.js";
import { reprocessMeeting } from "../api/meeting-notes.js";
import { say } from "./tool-result.js";

/** Re-transcribe saved meeting audio with the shared Whisper service and retry part summaries. */
export function meetingTool(sessionId: string) {
  return (pi: any): void => {
    pi.registerTool({
      name: "reprocess_saved_meeting",
      label: "Reprocess saved meeting",
      description: "Re-transcribe saved audio from a completed meeting with Yulify's shared Whisper service and refresh its three-minute transcript parts. Returns the refreshed transcript so you can summarize it in your response. If meeting_file is omitted, uses the newest saved meeting. Never invent missing words; preserve anonymous speaker labels and disclose gaps. This can take several minutes.",
      parameters: Type.Object({
        meeting_file: Type.Optional(Type.String({ description: "Optional meeting transcript filename, such as meeting-2026-10-28T02-18-11-100Z.txt" })),
      }),
      async execute(_id: string, p: { meeting_file?: string }, signal?: AbortSignal) {
        if (signal?.aborted) throw new Error("Meeting reprocessing was cancelled");
        const session = getSession(sessionId);
        if (!session) throw new Error("Chat session not found");
        const name = p.meeting_file?.trim();
        if (name && (path.basename(name) !== name || !/^meeting-[\w.-]+\.txt$/.test(name))) throw new Error("Use a meeting transcript filename from this chat's .meeting-notes folder");
        const result = await reprocessMeeting(sessionId, session.workspace, name);
        const transcript = fs.readFileSync(path.join(session.workspace, result.transcriptPath), "utf8");
        return say(`Reprocessed ${result.recorded_seconds.toFixed(1)} seconds of saved audio into ${result.turns} speaker-labelled turns. Transcript saved to ${result.transcriptPath}. The selected model cannot create isolated part summaries through chat completions; summarize the transcript below in your response. Preserve uncertainty and recording gaps.\n\n${transcript}`);
      },
    });
  };
}
