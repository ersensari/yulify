import { randomUUID } from "node:crypto";
import { guardExtension } from "./guard.js";

/** CLI children do not use the portal SDK loader. Install its guard explicitly. */
export default function (pi: any): void {
  const policy = JSON.parse(process.env.YULIFY_SUBAGENT_GUARD ?? "null");
  if (policy?.version !== 1 || typeof policy.readyCommand !== "string" ||
      typeof policy.who?.role !== "string" || typeof policy.enforceTaint !== "boolean" ||
      typeof policy.browser?.allowed !== "boolean" || !Array.isArray(policy.browser?.allowlist) ||
      !Array.isArray(policy.alsoReadable)) {
    throw new Error("Missing or invalid inherited subagent guard policy");
  }
  guardExtension(
    `subagent:${randomUUID()}`, () => policy.who, undefined,
    policy.enforceTaint, () => policy.browser, policy.workspace, policy.alsoReadable, true,
  )(pi);
  // Registered only after enforcement is installed. The parent checks this over
  // RPC before sending a task: extension-load failures must never fail open.
  pi.registerCommand(policy.readyCommand, {
    description: "Inherited subagent guard is installed",
    handler: async () => {},
  });
}
