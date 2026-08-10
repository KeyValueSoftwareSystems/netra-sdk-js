/**
 * E2E (real SDK client `Netra.redteam.runRedteam` + real HTTP loopback to a
 * contract-faithful mock backend — see mock-backend.ts for the feasibility
 * rationale): run creation, triggering an existing config.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRedteamBackend } from "./mock-backend";
import { newClient, resetRedteamEnv, FAST_POLL_ENV } from "./helpers";
import { RedteamConfigError, RedteamRunError } from "../../models";

describe("TC-01..TC-04 — Run creation", () => {
  let backend: MockRedteamBackend;

  beforeEach(async () => {
    backend = new MockRedteamBackend();
    await backend.start();
  });
  afterEach(async () => {
    await backend.stop();
    resetRedteamEnv();
  });

  it("TC-01: trigger an existing config, single-turn, happy path", async () => {
    const tenant = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const evaluator = backend.addEvaluator({ slug: "harmful-content" });
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [evaluator.id],
      turnType: "single",
    });

    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);
    const result = await client.runRedteam({
      configId: config.id,
      handler: async () => "my agent's reply",
    });

    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.status).toBe("completed");
    expect(result!.results).toHaveLength(1);
    expect(result!.riskScore).toBeDefined();
  });

  it("multi-turn config: multiple turns with incrementing turnIndex", async () => {
    const tenant = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const evaluator = backend.addEvaluator({ slug: "harmful-content" });
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [evaluator.id],
      turnType: "multi",
      multiTurnCount: 3,
    });

    const seenTurnIndexes: number[] = [];
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);
    const result = await client.runRedteam({
      configId: config.id,
      handler: async (_prompt, _sessionId, turnIndex) => {
        seenTurnIndexes.push(turnIndex);
        return "reply";
      },
    });

    expect(result!.success).toBe(true);
    expect(seenTurnIndexes).toEqual([1, 2, 3]);
  });

  it("iterative-jailbreak config: selected purely by evaluator slug, independent of turnType", async () => {
    const tenant = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const jailbreakEvaluator = backend.addEvaluator({ slug: "system-prompt-jailbreak", isJailbreak: true });
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [jailbreakEvaluator.id],
      // turnType left at its "single" default — the server selects jailbreak
      // behavior from the evaluator slug alone, independent of turnType.
    });

    const seenTurnIndexes: number[] = [];
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);
    const result = await client.runRedteam({
      configId: config.id,
      handler: async (_prompt, _sessionId, turnIndex) => {
        seenTurnIndexes.push(turnIndex);
        return "reply";
      },
    });

    expect(result!.success).toBe(true);
    expect(seenTurnIndexes.length).toBeGreaterThan(1);
    expect(seenTurnIndexes).toEqual([...seenTurnIndexes].sort((a, b) => a - b));
  });

  it("TC-02: config still generating — SDK retries createRun transparently, no caller-visible error", async () => {
    const tenant = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const evaluator = backend.addEvaluator();
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [evaluator.id],
      generationMode: "delayed",
      delayedFlipAfterPolls: 2,
    });

    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);
    const result = await client.runRedteam({
      configId: config.id,
      handler: async () => "reply",
    });

    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);

    const createRunCalls = backend.requestLog.filter(
      (r) => r.method === "POST" && r.path === "/redteam/sdk/runs",
    );
    // At least the initial call + the calls that saw "generating".
    expect(createRunCalls.length).toBeGreaterThan(1);
    for (const call of createRunCalls) {
      expect(call.body).toEqual({ configId: config.id });
    }
  });

  it("TC-03: a config belonging to another tenant/project — 404, RedteamConfigError, no turn loop starts", async () => {
    const tenantA = backend.addTenant();
    const tenantB = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenantB.projectId });
    const evaluator = backend.addEvaluator();
    const foreignConfig = backend.addConfig({
      projectId: tenantB.projectId,
      orgId: tenantB.orgId,
      agentId: agent.id,
      evaluatorIds: [evaluator.id],
    });

    const client = newClient(backend, tenantA.apiKey, FAST_POLL_ENV);
    await expect(
      client.runRedteam({ configId: foreignConfig.id, handler: async () => "x" }),
    ).rejects.toBeInstanceOf(RedteamConfigError);

    const promptsCalls = backend.requestLog.filter((r) => r.path.includes("/prompts"));
    expect(promptsCalls).toHaveLength(0);
  });

  it("TC-04: a config with an already-active run — 409, RedteamRunError", async () => {
    const tenant = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const evaluator = backend.addEvaluator();
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [evaluator.id],
    });
    config.hasActiveRun = true; // simulate another RUNNING run for this config

    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);
    await expect(
      client.runRedteam({ configId: config.id, handler: async () => "x" }),
    ).rejects.toBeInstanceOf(RedteamRunError);
  });
});
