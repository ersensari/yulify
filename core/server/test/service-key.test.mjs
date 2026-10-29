import test from "node:test";
import assert from "node:assert";

process.env.PORTAL_PASSWORD = "a-long-enough-password";
process.env.PORTAL_SERVICE_KEY = "k".repeat(40);
const { isServiceRequest } = await import("../dist/auth.js");

const req = (over = {}) => ({ headers: { authorization: `Bearer ${"k".repeat(40)}`, ...(over.headers || {}) }, socket: { remoteAddress: over.ip ?? "127.0.0.1" } });

test("direct local request with the key is a service request", () => {
  assert.equal(isServiceRequest(req()), true);
  assert.equal(isServiceRequest(req({ ip: "::1" })), true);
});
test("wrong key, missing key, remote address or a proxied request is refused", () => {
  assert.equal(isServiceRequest(req({ headers: { authorization: "Bearer nope" } })), false);
  assert.equal(isServiceRequest({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), false);
  assert.equal(isServiceRequest(req({ ip: "100.64.0.9" })), false);
  assert.equal(isServiceRequest(req({ headers: { "x-forwarded-for": "1.2.3.4" } })), false);
});
