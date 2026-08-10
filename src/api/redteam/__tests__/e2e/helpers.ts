/**
 * QA fixture — NOT product source. Shared setup helpers for the red-team SDK
 * E2E suite. Constructs the REAL `Redteam` client (real `RedteamHttpClient`/
 * axios, no mocking of the client itself) wired at a real HTTP loopback
 * connection to `MockRedteamBackend`.
 */
import { Config } from "../../../../config";
import { Redteam } from "../../api";
import { MockRedteamBackend } from "./mock-backend";

/** Build a real `Redteam` client pointed at `backend.url`, authenticated as `apiKey`. */
export function newClient(backend: MockRedteamBackend, apiKey: string, extraEnv: Record<string, string> = {}): Redteam {
  process.env.NETRA_OTLP_ENDPOINT = backend.url;
  process.env.NETRA_API_KEY = apiKey;
  for (const [k, v] of Object.entries(extraEnv)) {
    process.env[k] = v;
  }
  const config = new Config({});
  return new Redteam(config);
}

/** Reset the subset of env vars this suite touches, so tests don't leak config into each other. */
export function resetRedteamEnv(): void {
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
