/**
 * E2E: prompt generation gating.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRedTeamBackend } from "./mock-backend";
import { newClient, resetRedTeamEnv, FAST_POLL_ENV } from "./helpers";
import { RedTeamGenerationError, RedTeamGenerationTimeoutError } from "../../models";

describe("Prompt generation gating", () => {
  let backend: MockRedTeamBackend;

  beforeEach(async () => {
    backend = new MockRedTeamBackend();
    await backend.start();
  });
  afterEach(async () => {
    await backend.stop();
    resetRedTeamEnv();
  });

  it("generation completes within the poll budget — SDK transparently waits (retrying create-run) then proceeds", async () => {
    const tenant = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const evaluator = backend.addEvaluator();
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [evaluator.id],
      generationMode: "delayed",
      delayedFlipAfterPolls: 3,
    });
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    const result = await client.runRedTeam({ configId: config.id, task: async () => "reply" });
    expect(result!.success).toBe(true);
  });

  it("generation fails (promptsGenerationFailedAt) — 502, RedTeamGenerationError", async () => {
    const tenant = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const evaluator = backend.addEvaluator();
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [evaluator.id],
      generationMode: "failed",
    });
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    await expect(
      client.runRedTeam({ configId: config.id, task: async () => "reply" }),
    ).rejects.toBeInstanceOf(RedTeamGenerationError);
  });

  it("generation worker unavailable / poll budget exhausted with no progress — 503, RedTeamGenerationTimeoutError", async () => {
    const tenant = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const evaluator = backend.addEvaluator();
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [evaluator.id],
      generationMode: "unavailable",
    });
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    await expect(
      client.runRedTeam({ configId: config.id, task: async () => "reply" }),
    ).rejects.toBeInstanceOf(RedTeamGenerationTimeoutError);
  });
});
