/**
 * E2E: the client-driven turn loop. The client fetches a run's whole prompt
 * list ONCE (`GET .../prompts`), then drives every session's turns itself,
 * holding all "what's next" state in memory between `POST .../turns` calls —
 * there is no persisted turn-state, no server-side claim of any kind, no
 * polling for "not-ready". All requests go over a real HTTP loopback to the
 * mock backend, driven by the real SDK client (`RedTeam`/`RedTeamHttpClient`,
 * unmocked).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRedTeamBackend } from "./mock-backend";
import { newClient, resetRedTeamEnv, FAST_POLL_ENV } from "./helpers";
import { Config } from "../../../../config";
import { RedTeamHttpClient } from "../../client";

function newRawClient(backend: MockRedTeamBackend, apiKey: string): RedTeamHttpClient {
  process.env.NETRA_OTLP_ENDPOINT = backend.url;
  process.env.NETRA_API_KEY = apiKey;
  return new RedTeamHttpClient(new Config({}));
}

describe("Client-driven turn loop (revision 7 architecture)", () => {
  let backend: MockRedTeamBackend;

  beforeEach(async () => {
    backend = new MockRedTeamBackend();
    await backend.start();
  });
  afterEach(async () => {
    await backend.stop();
    resetRedTeamEnv();
  });

  function seedRun(opts: { sessionsPerEvaluator?: number; turnType?: "single" | "multi"; multiTurnCount?: number } = {}) {
    const tenant = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const evaluator = backend.addEvaluator();
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [evaluator.id],
      sessionsPerEvaluator: opts.sessionsPerEvaluator ?? 1,
      turnType: opts.turnType ?? "single",
      multiTurnCount: opts.multiTurnCount,
    });
    return { tenant, config };
  }

  it("GET .../prompts returns the whole list in one call, immediately — no polling of any kind", async () => {
    const { tenant, config } = seedRun({ sessionsPerEvaluator: 3 });
    const raw = newRawClient(backend, tenant.apiKey);
    const created = await raw.createRun({ configId: config.id });
    if (created.status !== "running") throw new Error("expected running");

    const start = Date.now();
    const resp = await raw.getPrompts(created.runId);
    const elapsed = Date.now() - start;

    expect(resp.prompts).toHaveLength(3);
    expect(elapsed).toBeLessThan(500);
    // A second call is idempotent — same list, no side effects, no claiming.
    const second = await raw.getPrompts(created.runId);
    expect(second.prompts.map((p) => p.id).sort()).toEqual(resp.prompts.map((p) => p.id).sort());
  });

  it("submitTurn reflects done correctly mid-run and at run end", async () => {
    const { tenant, config } = seedRun({ turnType: "multi", multiTurnCount: 3 });
    const raw = newRawClient(backend, tenant.apiKey);
    const created = await raw.createRun({ configId: config.id });
    if (created.status !== "running") throw new Error("expected running");

    const { prompts } = await raw.getPrompts(created.runId);
    const [prompt] = prompts;

    const turn1 = await raw.submitTurn(created.runId, {
      promptId: prompt.id,
      sessionId: prompt.id,
      turnIndex: 1,
      promptText: prompt.prompt,
      output: "reply 1",
    });
    expect(turn1.done).toBe(false);
    expect(turn1.nextPrompt).toBeTruthy();
    expect(turn1.nextTurnIndex).toBe(2);

    const turn2 = await raw.submitTurn(created.runId, {
      promptId: prompt.id,
      sessionId: prompt.id,
      turnIndex: 2,
      promptText: turn1.nextPrompt as string,
      output: "reply 2",
    });
    expect(turn2.done).toBe(false);

    const turn3 = await raw.submitTurn(created.runId, {
      promptId: prompt.id,
      sessionId: prompt.id,
      turnIndex: 3,
      promptText: turn2.nextPrompt as string,
      output: "reply 3",
    });
    expect(turn3.done).toBe(true);

    const afterDone = await raw.getPrompts(created.runId);
    expect(afterDone.status).toBe("completed");
  });

  it("duplicate (run, promptId, turnIndex) submission — 409, not a silent overwrite or double-count", async () => {
    const { tenant, config } = seedRun();
    const raw = newRawClient(backend, tenant.apiKey);
    const created = await raw.createRun({ configId: config.id });
    if (created.status !== "running") throw new Error("expected running");

    const { prompts } = await raw.getPrompts(created.runId);
    const [prompt] = prompts;
    const body = { promptId: prompt.id, sessionId: prompt.id, turnIndex: 1, promptText: prompt.prompt, output: "reply" };

    const first = await raw.submitTurn(created.runId, body);
    expect(first.done).toBe(true);

    // The client normalizes the backend's 409 to {done: true} rather than
    // throwing (same treatment as an already-accepted turn), so a retry
    // doesn't crash the caller — but it must not be double-counted server-side.
    const duplicate = await raw.submitTurn(created.runId, body);
    expect(duplicate.done).toBe(true);

    const run = backend.getRun(created.runId)!;
    expect(run.results).toHaveLength(1); // not double-counted
  });

  it("multiple sessions on one run advance independently, no lost turns, no cross-talk", async () => {
    const { tenant, config } = seedRun({ sessionsPerEvaluator: 3, turnType: "multi", multiTurnCount: 2 });
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    const seenPromptIds = new Set<string>();
    const result = await client.runRedTeam({
      configId: config.id,
      maxConcurrency: 3,
      task: async (_prompt: string, sessionId: string) => {
        seenPromptIds.add(sessionId);
        return "reply";
      },
    });

    expect(result!.success).toBe(true);
    expect(seenPromptIds.size).toBe(3); // every session was driven, none skipped or merged
    const run = backend.getRun(result!.runId)!;
    expect(run.results).toHaveLength(6); // 3 sessions * 2 turns each
  });

  it("promptId from a different run is rejected — 404", async () => {
    const { tenant, config } = seedRun();
    const raw = newRawClient(backend, tenant.apiKey);
    const created1 = await raw.createRun({ configId: config.id });
    if (created1.status !== "running") throw new Error("expected running");
    const { prompts } = await raw.getPrompts(created1.runId);
    const [promptFromRun1] = prompts;

    const config2 = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: config.agentId,
      evaluatorIds: config.evaluatorIds,
    });
    const created2 = await raw.createRun({ configId: config2.id });
    if (created2.status !== "running") throw new Error("expected running");

    await expect(
      raw.submitTurn(created2.runId, {
        promptId: promptFromRun1.id,
        sessionId: promptFromRun1.id,
        turnIndex: 1,
        promptText: promptFromRun1.prompt,
        output: "reply",
      }),
    ).rejects.toThrow();
  });

  it("zero prompts (empty run) — completes immediately with no turns to drive", async () => {
    const { tenant, config } = seedRun({ sessionsPerEvaluator: 0 });
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    const task = async () => "unused";
    const result = await client.runRedTeam({ configId: config.id, task });

    expect(result!.status).toBe("completed");
    expect(result!.results).toHaveLength(0);
  });
});
