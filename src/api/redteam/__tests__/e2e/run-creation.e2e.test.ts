/**
 * E2E (real SDK client `Netra.redTeam.runRedTeam` + real HTTP loopback to a
 * contract-faithful mock backend — see mock-backend.ts for the feasibility
 * rationale): run creation, triggering an existing config.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRedTeamBackend } from "./mock-backend";
import { newClient, resetRedTeamEnv, FAST_POLL_ENV } from "./helpers";
import { RedTeamConfigError, RedTeamRunError } from "../../models";

describe("Run creation", () => {
  let backend: MockRedTeamBackend;

  beforeEach(async () => {
    backend = new MockRedTeamBackend();
    await backend.start();
  });
  afterEach(async () => {
    await backend.stop();
    resetRedTeamEnv();
  });

  it("trigger an existing config, single-turn, happy path", async () => {
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
    const result = await client.runRedTeam({
      configId: config.id,
      task: async () => "my agent's reply",
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
    const result = await client.runRedTeam({
      configId: config.id,
      task: async (_prompt, _sessionId, turnIndex) => {
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
    const result = await client.runRedTeam({
      configId: config.id,
      task: async (_prompt, _sessionId, turnIndex) => {
        seenTurnIndexes.push(turnIndex);
        return "reply";
      },
    });

    expect(result!.success).toBe(true);
    expect(seenTurnIndexes.length).toBeGreaterThan(1);
    expect(seenTurnIndexes).toEqual([...seenTurnIndexes].sort((a, b) => a - b));
  });

  it("config still generating — SDK retries createRun transparently, no caller-visible error", async () => {
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
    const result = await client.runRedTeam({
      configId: config.id,
      task: async () => "reply",
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

  it("a config belonging to another tenant/project — 404, RedTeamConfigError, no turn loop starts", async () => {
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
      client.runRedTeam({ configId: foreignConfig.id, task: async () => "x" }),
    ).rejects.toBeInstanceOf(RedTeamConfigError);

    const promptsCalls = backend.requestLog.filter((r) => r.path.includes("/prompts"));
    expect(promptsCalls).toHaveLength(0);
  });

  it("a config with an already-active run — 409, RedTeamRunError", async () => {
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
      client.runRedTeam({ configId: config.id, task: async () => "x" }),
    ).rejects.toBeInstanceOf(RedTeamRunError);
  });
});
