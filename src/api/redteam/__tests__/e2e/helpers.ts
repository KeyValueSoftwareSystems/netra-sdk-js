/**
 * QA fixture — NOT product source. Shared setup helpers for the red-team SDK
 * E2E suite. Constructs the REAL `RedTeam` client (real `RedTeamHttpClient`/
 * axios, no mocking of the client itself) wired at a real HTTP loopback
 * connection to `MockRedTeamBackend`.
 */
import { Config } from "../../../../config";
import { RedTeam } from "../../api";
import { MockRedTeamBackend } from "./mock-backend";

/** Build a real `RedTeam` client pointed at `backend.url`, authenticated as `apiKey`. */
export function newClient(backend: MockRedTeamBackend, apiKey: string, extraEnv: Record<string, string> = {}): RedTeam {
  process.env.NETRA_OTLP_ENDPOINT = backend.url;
  process.env.NETRA_API_KEY = apiKey;
  for (const [k, v] of Object.entries(extraEnv)) {
    process.env[k] = v;
  }
  const config = new Config({});
  return new RedTeam(config);
}

/** Reset the subset of env vars this suite touches, so tests don't leak config into each other. */
export function resetRedTeamEnv(): void {
  delete process.env.NETRA_OTLP_ENDPOINT;
  delete process.env.NETRA_API_KEY;
  delete process.env.NETRA_REDTEAM_GENERATION_POLL_INTERVAL;
  delete process.env.NETRA_REDTEAM_GENERATION_TIMEOUT;
  delete process.env.NETRA_REDTEAM_TIMEOUT;
}

/** Fast generation-gating poll, for tests that don't care about the "generating" gate's real timing. */
export const FAST_POLL_ENV = {
  NETRA_REDTEAM_GENERATION_POLL_INTERVAL: "0.05",
  NETRA_REDTEAM_GENERATION_TIMEOUT: "5",
};
