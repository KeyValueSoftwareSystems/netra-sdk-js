/**
 * E2E: prompt generation gating.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRedteamBackend } from "./mock-backend";
import { newClient, resetRedteamEnv, FAST_POLL_ENV } from "./helpers";
import { RedteamGenerationError, RedteamGenerationTimeoutError } from "../../models";

describe("TC-34..TC-36 — Prompt generation gating", () => {
  let backend: MockRedteamBackend;

  beforeEach(async () => {
    backend = new MockRedteamBackend();
    await backend.start();
  });
  afterEach(async () => {
    await backend.stop();
    resetRedteamEnv();
  });

  it("TC-34: generation completes within the poll budget — SDK transparently waits (retrying create-run) then proceeds", async () => {
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

    const result = await client.runRedteam({ configId: config.id, handler: async () => "reply" });
    expect(result!.success).toBe(true);
  });

  it("TC-35: generation fails (promptsGenerationFailedAt) — 502, RedteamGenerationError", async () => {
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
      client.runRedteam({ configId: config.id, handler: async () => "reply" }),
    ).rejects.toBeInstanceOf(RedteamGenerationError);
  });

  it("TC-36: generation worker unavailable / poll budget exhausted with no progress — 503, RedteamGenerationTimeoutError", async () => {
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
      client.runRedteam({ configId: config.id, handler: async () => "reply" }),
    ).rejects.toBeInstanceOf(RedteamGenerationTimeoutError);
  });
});
