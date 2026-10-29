/** Fixed-protocol voice requests must not use global fetch: Pi extensions can
 * intercept it and inject coding-agent system messages (billion-context).
 * Keep provider authentication and cancellation, using Node's HTTP transport.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export function postVoiceCoordinator(url: string, headers: Record<string, string>, payload: unknown, signal: AbortSignal): Promise<{ ok: boolean; status: number; json(): Promise<any> }> {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Unsupported voice provider protocol");
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(target, { method: "POST", signal, headers: { ...headers, "Content-Length": String(body.length) } }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          response.destroy(new Error("Voice coordinator response exceeds 2 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const status = response.statusCode ?? 502;
        resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(raw) });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}
