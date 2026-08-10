/**
 * E2E: input validation. These are rejected client-side before any network
 * call reaches the (real, running) mock backend — asserted here by checking
 * the request log stays empty, proving the real SDK's runtime guard actually
 * fires.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRedteamBackend } from "./mock-backend";
import { newClient, resetRedteamEnv, FAST_POLL_ENV } from "./helpers";
import type { RedteamRunOptions } from "../../models";

describe("TC-11..TC-14 — Input validation", () => {
  let backend: MockRedteamBackend;

  beforeEach(async () => {
    backend = new MockRedteamBackend();
    await backend.start();
  });
  afterEach(async () => {
    await backend.stop();
    resetRedteamEnv();
  });

  it("TC-12: configId missing — rejected client-side, no network call", async () => {
    const tenant = backend.addTenant();
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    const options = { handler: async () => "reply" } as unknown as RedteamRunOptions;

    const result = await client.runRedteam(options);
    expect(result).toBeNull();
    expect(backend.requestLog).toHaveLength(0);
  });

  it("TC-14: unknown extra fields on the options object are not forwarded to the wire", async () => {
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
      handler: async () => "reply",
    } as unknown as RedteamRunOptions;

    const result = await client.runRedteam(bypassed);
    expect(result!.success).toBe(true);

    const createRunCall = backend.requestLog.find((r) => r.method === "POST" && r.path === "/redteam/sdk/runs");
    expect(createRunCall!.body).toEqual({ configId: config.id });
  });
});
