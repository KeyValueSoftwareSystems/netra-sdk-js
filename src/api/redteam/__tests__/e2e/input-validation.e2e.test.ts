/**
 * E2E: input validation. These are rejected client-side before any network
 * call reaches the (real, running) mock backend — asserted here by checking
 * the request log stays empty, proving the real SDK's runtime guard actually
 * fires.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRedTeamBackend } from "./mock-backend";
import { newClient, resetRedTeamEnv, FAST_POLL_ENV } from "./helpers";
import type { RedTeamRunOptions } from "../../models";

describe("Input validation", () => {
  let backend: MockRedTeamBackend;

  beforeEach(async () => {
    backend = new MockRedTeamBackend();
    await backend.start();
  });
  afterEach(async () => {
    await backend.stop();
    resetRedTeamEnv();
  });

  it("configId missing — rejected client-side, no network call", async () => {
    const tenant = backend.addTenant();
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    const options = { task: async () => "reply" } as unknown as RedTeamRunOptions;

    const result = await client.runRedTeam(options);
    expect(result).toBeNull();
    expect(backend.requestLog).toHaveLength(0);
  });

  it("unknown extra fields on the options object are not forwarded to the wire", async () => {
    // A caller who bypasses TypeScript (plain JS, or an `as any` cast) must
    // not get any of these forwarded — `buildCreateRunBody` keys only on
    // `configId`.
    const tenant = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const evaluator = backend.addEvaluator();
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [evaluator.id],
    });
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    const bypassed = {
      configId: config.id,
      unknownField: "should-not-be-forwarded",
      multiTurnCount: 99,
      task: async () => "reply",
    } as unknown as RedTeamRunOptions;

    const result = await client.runRedTeam(bypassed);
    expect(result!.success).toBe(true);

    const createRunCall = backend.requestLog.find((r) => r.method === "POST" && r.path === "/redteam/sdk/runs");
    expect(createRunCall!.body).toEqual({ configId: config.id });
  });
});
