/**
 * `social unschedule <id>` (scripts/social/unschedule.ts): one POST with the
 * session id, printed plainly or as JSON. The client is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerUnschedule } from "../unschedule.js";

const OUT = { draftId: "d1", status: "draft", removedLegs: ["linkedin:pending", "bluesky:pending"] };
const request = vi.fn();
let log: ReturnType<typeof vi.spyOn>;

function program() {
  const p = new Command().exitOverride();
  registerUnschedule(p, () => ({ baseUrl: "https://social.example.com", request }));
  return p;
}

beforeEach(() => {
  request.mockReset().mockResolvedValue(OUT);
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  log.mockClear();
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("the unschedule command", () => {
  it("POSTs the session to the draft's path-encoded unschedule and says what happened", async () => {
    await program().parseAsync(["node", "social", "unschedule", "d1/x", "--session", "sess-1"]);
    expect(request).toHaveBeenCalledWith("POST", "/drafts/d1%2Fx/unschedule", { sessionId: "sess-1" });
    expect(log).toHaveBeenCalledWith(
      "unscheduled d1: now draft; removed linkedin:pending, bluesky:pending. Its approval is cancelled.",
    );
  });

  it("takes the session from CLAUDE_CODE_SESSION_ID, and prints JSON on --json", async () => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "env-sess");
    await program().parseAsync(["node", "social", "unschedule", "d1", "--json"]);
    expect(request.mock.calls[0]![2]).toEqual({ sessionId: "env-sess" });
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(OUT);
  });

  it("refuses to run with no session id, before any request", async () => {
    await expect(program().parseAsync(["node", "social", "unschedule", "d1"])).rejects.toThrow(/needs --session/);
    expect(request).not.toHaveBeenCalled();
  });
});
