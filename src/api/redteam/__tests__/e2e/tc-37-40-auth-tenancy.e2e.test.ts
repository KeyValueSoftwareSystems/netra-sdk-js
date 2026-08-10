/**
 * E2E: auth, tenancy, and entitlement.
 *
 * TC-40 (SDK-triggered run attribution / `triggered_by`) is a backend/DB
 * column not exposed on any SDK-facing response shape (`RunProgress`/
 * `RiskScore` are opaque, backend-defined shapes, and `triggered_by` is not
 * part of the SDK's contract at all). It is therefore not observable through
 * this suite's black-box SDK-driven surface; it is asserted at the
 * backend-integration level in the backend repo's own test suite. Marked
 * unautomatable-here explicitly rather than silently dropped.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRedteamBackend } from "./mock-backend";
import { newClient, resetRedteamEnv, FAST_POLL_ENV } from "./helpers";
import { RedteamAuthError } from "../../models";

describe("TC-37..TC-39 — Auth, tenancy, and entitlement", () => {
  let backend: MockRedteamBackend;

  beforeEach(async () => {
    backend = new MockRedteamBackend();
    await backend.start();
  });
  afterEach(async () => {
    await backend.stop();
    resetRedteamEnv();
  });

  it("TC-37: missing or invalid API key — 401, RedteamAuthError", async () => {
    backend.addTenant({ apiKey: "the-real-key" });
    const client = newClient(backend, "garbage-key-not-registered", FAST_POLL_ENV);

    await expect(
      client.runRedteam({ configId: "cfg-x", handler: async () => "reply" }),
    ).rejects.toBeInstanceOf(RedteamAuthError);
  });

  it("TC-38: feature flag disabled for the org — 403, RedteamAuthError", async () => {
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
      client.runRedteam({ configId: config.id, handler: async () => "reply" }),
    ).rejects.toBeInstanceOf(RedteamAuthError);
  });

  it("TC-39: cross-tenant run/result access — 404 on every read endpoint, no data leaks across tenants", async () => {
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
    const result = await clientA.runRedteam({ configId: configA.id, handler: async () => "reply" });
    expect(result!.success).toBe(true);

    const clientB = newClient(backend, tenantB.apiKey, FAST_POLL_ENV);
    // Every read surface must 404 for tenant B against tenant A's run/config.
    await expect(clientB.getResults(result!.runId)).rejects.toThrow();
    await expect(clientB.cancel(result!.runId)).rejects.toThrow();

    const rawRiskCheck = async () => {
      const { RedteamHttpClient } = await import("../../client");
      const { Config } = await import("../../../../config");
      process.env.NETRA_OTLP_ENDPOINT = backend.url;
      process.env.NETRA_API_KEY = tenantB.apiKey;
      const raw = new RedteamHttpClient(new Config({}));
      return raw.getRiskScore(configA.id);
    };
    await expect(rawRiskCheck()).rejects.toThrow();
  });
});
