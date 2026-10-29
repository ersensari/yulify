import { randomUUID } from "node:crypto";
import { browserCall, guardExtension } from "./guard.js";
import { GUARD_RULE_NAMES } from "./guard-rule-names.js";

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
    () => new Set(policy.enforceTaint ? [] : GUARD_RULE_NAMES),
    () => policy.browser.allowlist, policy.workspace, policy.alsoReadable,
  )(pi);
  // The parent grants browser access per session; the upstream guard handles
  // host allowlists but does not itself carry that inherited enable switch.
  pi.on("tool_call", (event: any) => {
    const input = event.input && typeof event.input === "object" ? event.input : {};
    if (!policy.browser.allowed && browserCall(String(event.toolName ?? ""), input).isBrowser) {
      return { block: true, reason: "This session has not enabled browser access." };
    }
    return undefined;
  });
  // Registered only after enforcement is installed. The parent checks this over
  // RPC before sending a task: extension-load failures must never fail open.
  pi.registerCommand(policy.readyCommand, {
    description: "Inherited subagent guard is installed",
    handler: async () => {},
  });
}
