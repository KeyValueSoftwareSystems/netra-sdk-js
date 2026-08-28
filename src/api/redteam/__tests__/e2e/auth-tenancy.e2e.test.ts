/**
 * E2E: auth, tenancy, and entitlement.
 *
 * SDK-triggered run attribution (`triggered_by`) is a backend/DB
 * column not exposed on any SDK-facing response shape (`RunProgress`/
 * `RiskScore` are opaque, backend-defined shapes, and `triggered_by` is not
 * part of the SDK's contract at all). It is therefore not observable through
 * this suite's black-box SDK-driven surface; it is asserted at the
 * backend-integration level in the backend repo's own test suite. Marked
 * unautomatable-here explicitly rather than silently dropped.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRedTeamBackend } from "./mock-backend";
import { newClient, resetRedTeamEnv, FAST_POLL_ENV } from "./helpers";
import { RedTeamAuthError } from "../../models";

describe("Auth, tenancy, and entitlement", () => {
  let backend: MockRedTeamBackend;

  beforeEach(async () => {
    backend = new MockRedTeamBackend();
    await backend.start();
  });
  afterEach(async () => {
    await backend.stop();
    resetRedTeamEnv();
  });

  it("missing or invalid API key — 401, RedTeamAuthError", async () => {
    backend.addTenant({ apiKey: "the-real-key" });
    const client = newClient(backend, "garbage-key-not-registered", FAST_POLL_ENV);

    await expect(
      client.runRedTeam({ configId: "cfg-x", task: async () => "reply" }),
    ).rejects.toBeInstanceOf(RedTeamAuthError);
  });

  it("feature flag disabled for the org — 403, RedTeamAuthError", async () => {
    const tenant = backend.addTenant({ featureFlagEnabled: false });
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const evaluator = backend.addEvaluator();
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [evaluator.id],
    });
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    await expect(
      client.runRedTeam({ configId: config.id, task: async () => "reply" }),
    ).rejects.toBeInstanceOf(RedTeamAuthError);
  });

  it("cross-tenant run/result access — 404 on every read endpoint, no data leaks across tenants", async () => {
    const tenantA = backend.addTenant();
    const tenantB = backend.addTenant();
    const agentA = backend.addAgent({ projectId: tenantA.projectId });
    const evaluatorA = backend.addEvaluator();
    const configA = backend.addConfig({
      projectId: tenantA.projectId,
      orgId: tenantA.orgId,
      agentId: agentA.id,
      evaluatorIds: [evaluatorA.id],
    });

    const clientA = newClient(backend, tenantA.apiKey, FAST_POLL_ENV);
    const result = await clientA.runRedTeam({ configId: configA.id, task: async () => "reply" });
    expect(result!.success).toBe(true);

    const clientB = newClient(backend, tenantB.apiKey, FAST_POLL_ENV);
    // Every read surface must 404 for tenant B against tenant A's run/config.
    await expect(clientB.getResults(result!.runId)).rejects.toThrow();
    await expect(clientB.cancel(result!.runId)).rejects.toThrow();

    const rawRiskCheck = async () => {
      const { RedTeamHttpClient } = await import("../../client");
      const { Config } = await import("../../../../config");
      process.env.NETRA_OTLP_ENDPOINT = backend.url;
      process.env.NETRA_API_KEY = tenantB.apiKey;
      const raw = new RedTeamHttpClient(new Config({}));
      return raw.getRiskScore(configA.id);
    };
    await expect(rawRiskCheck()).rejects.toThrow();
  });
});
