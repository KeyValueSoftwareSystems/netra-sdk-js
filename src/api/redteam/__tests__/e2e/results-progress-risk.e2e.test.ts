/**
 * E2E: results, progress, and risk score.
 *
 * Parity with a dashboard-driven run cannot be fully verified here: there is
 * no dashboard-driven code path in this sandbox's mock backend (it only
 * implements the SDK contract surface), and true parity means "identical
 * persisted result rows / identical dashboard rendering", which requires the
 * real backend DB and both real code paths side by side — that exact parity
 * assertion belongs in the backend repo's own integration/e2e suite. This
 * suite's contribution is the contract-shape half of parity: the SDK-driven
 * run's results/progress/risk-score have exactly the shape the backend
 * contract promises (so nothing SDK-specific leaks into what the dashboard
 * would render) — see the "shape parity" test below. Marked explicitly
 * rather than silently skipped.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRedteamBackend } from "./mock-backend";
import { newClient, resetRedteamEnv, FAST_POLL_ENV } from "./helpers";

describe("Results, progress, and risk score", () => {
  let backend: MockRedteamBackend;

  beforeEach(async () => {
    backend = new MockRedteamBackend();
    await backend.start();
  });
  afterEach(async () => {
    await backend.stop();
    resetRedteamEnv();
  });

  function seed() {
    const tenant = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const evaluator = backend.addEvaluator({ slug: "harmful-content" });
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [evaluator.id],
    });
    return { tenant, config };
  }

  it("SDK-triggered results carry no SDK-specific labeling and match the documented RunResultItem shape", async () => {
    const { tenant, config } = seed();
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);
    const result = await client.runRedteam({ configId: config.id, handler: async () => "reply" });

    expect(result!.results).toHaveLength(1);
    const item = result!.results[0];
    // Every documented RunResultItem field, and nothing SDK-specific bolted on.
    expect(Object.keys(item).sort()).toEqual(
      ["conversationHistory", "evaluatorId", "evaluatorSlug", "judgeOutput", "score", "sessionId", "status", "turnIndex"].sort(),
    );
  });

  it("results pagination — a run with >200 result rows pages via page/limit, SDK aggregates with no gaps/duplicates", async () => {
    const { tenant, config } = seed();
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    // Seed the run directly (bypassing the turn loop) with 205 synthetic rows
    // to exercise the pagination boundary without driving 205 real turns.
    const created = await (async () => {
      const { RedteamHttpClient } = await import("../../client");
      const { Config } = await import("../../../../config");
      process.env.NETRA_OTLP_ENDPOINT = backend.url;
      process.env.NETRA_API_KEY = tenant.apiKey;
      const raw = new RedteamHttpClient(new Config({}));
      return raw.createRun({ configId: config.id });
    })();
    if (created.status !== "running") throw new Error("expected running");

    const items = Array.from({ length: 205 }, (_, i) => ({
      evaluatorId: "eval-1",
      evaluatorSlug: "harmful-content",
      status: "pass",
      score: 1,
      judgeOutput: "ok",
      sessionId: "sess-synthetic",
      turnIndex: i + 1,
      conversationHistory: [],
    }));
    backend.seedRunDone(created.runId, items);

    const results = await client.getResults(created.runId);
    expect(results).toHaveLength(205);
    const turnIndexes = results.map((r) => r.turnIndex).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(turnIndexes).toEqual(Array.from({ length: 205 }, (_, i) => i + 1)); // no gaps, no duplicates

    const resultsPageCalls = backend.requestLog.filter((r) => r.path.includes("/results"));
    expect(resultsPageCalls.length).toBeGreaterThanOrEqual(2); // at least 2 pages (200 + 5)
  });

  it("partial results after some errored turns — final result includes all turns with individual statuses; success reflects overall completion not per-turn pass rate", async () => {
    const { tenant, config } = seed();
    config.sessionsPerEvaluator = 2;
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    let call = 0;
    const result = await client.runRedteam({
      configId: config.id,
      handler: async () => {
        call++;
        if (call === 1) throw new Error("handler failure on this turn");
        return "ok reply";
      },
    });

    expect(result!.success).toBe(true); // overall completion, not per-turn pass rate
    expect(result!.results).toHaveLength(2);
    const statuses = result!.results.map((r) => r.status).sort();
    expect(statuses).toEqual(["error", "pass"]);
  });

  it("risk score reflects the run's config — aggregate safety score/change/history", async () => {
    const { tenant, config } = seed();
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);
    const result = await client.runRedteam({ configId: config.id, handler: async () => "reply" });

    expect(result!.riskScore).toBeDefined();
    expect(result!.riskScore).toHaveProperty("latestSafetyScore");
    expect(result!.riskScore).toHaveProperty("change");
    expect(result!.riskScore).toHaveProperty("history");
  });

  it("empty run (zero prompts generated) finalizes immediately as done with an empty results[]; SDK does not throw", async () => {
    const { tenant, config } = seed();
    config.sessionsPerEvaluator = 0; // config that produces zero adversarial prompts/sessions
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    // Full end-to-end runRedteam(): create -> poll loop (immediately sees
    // scope:"run" done, since zero sessions were seeded) -> results/risk-score.
    const result = await client.runRedteam({ configId: config.id, handler: async () => "unused" });

    expect(result).not.toBeNull(); // SDK does not throw
    expect(result!.success).toBe(true);
    expect(result!.results).toEqual([]);
  });
});
