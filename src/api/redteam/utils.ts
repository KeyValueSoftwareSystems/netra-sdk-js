import { Logger } from "../../logger";
import {
  CreateRunRequestBody,
  RedTeamRunOptions,
  RiskScore,
  RunResultItem,
  RunResultsPage,
} from "./models";

const LOG_PREFIX = "netra.redteam";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a `RedTeamRunOptions` object before any network call.
 *
 * Rules:
 *  1. `typeof task === "function"`.
 *  2. `configId` must be present.
 *  3. `maxConcurrency`, if given, must be a positive integer — 0/negative/non-integer would
 *     silently produce zero pollers (`_runSessionsAsync` resolves immediately with no work done),
 *     which `runRedTeam` would otherwise report as a misleading `{success:true, results:[]}`.
 *
 * @returns `true` when valid; `null` when invalid (after logging the reason).
 */
export function validateRedTeamInputs(
  options: RedTeamRunOptions | null | undefined,
): true | null {
  if (!options || typeof options !== "object") {
    Logger.error(`${LOG_PREFIX}: options object is required`);
    return null;
  }

  if (typeof options.task !== "function") {
    Logger.error(
      `${LOG_PREFIX}: task must be a function (prompt, sessionId, turnIndex) => Promise<string>`,
    );
    return null;
  }

  if (!options.configId) {
    Logger.error(`${LOG_PREFIX}: configId is required`);
    return null;
  }

  if (
    options.maxConcurrency !== undefined &&
    (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1)
  ) {
    Logger.error(`${LOG_PREFIX}: maxConcurrency must be a positive integer, got ${options.maxConcurrency}`);
    return null;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Wire body builder
// ---------------------------------------------------------------------------

/** Build the create-run request body from public `RedTeamRunOptions`. */
export function buildCreateRunBody(
  options: RedTeamRunOptions,
): CreateRunRequestBody {
  return { configId: options.configId };
}

// ---------------------------------------------------------------------------
// Env parsing
// ---------------------------------------------------------------------------

const DEFAULT_REDTEAM_TIMEOUT_S = 20; // ordinary REST timeout
const DEFAULT_GENERATION_POLL_INTERVAL_S = 2;
const DEFAULT_GENERATION_TIMEOUT_S = 300;

function parseNumericEnv(
  envVar: string,
  defaultValue: number,
): number {
  const raw = process.env[envVar];
  if (!raw) {
    return defaultValue;
  }
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) {
    Logger.warn(
      `${LOG_PREFIX}: Invalid ${envVar} value '${raw}', using default ${defaultValue}`,
    );
    return defaultValue;
  }
  return parsed;
}

/** `NETRA_REDTEAM_TIMEOUT` (seconds) -> ms. Ordinary REST timeout, not a long-poll wait. */
export function getRedTeamTimeoutMs(): number {
  return parseNumericEnv("NETRA_REDTEAM_TIMEOUT", DEFAULT_REDTEAM_TIMEOUT_S) * 1000;
}

/** `NETRA_REDTEAM_GENERATION_POLL_INTERVAL` (seconds) -> ms. */
export function getGenerationPollIntervalMs(): number {
  return parseNumericEnv("NETRA_REDTEAM_GENERATION_POLL_INTERVAL", DEFAULT_GENERATION_POLL_INTERVAL_S) * 1000;
}

/** `NETRA_REDTEAM_GENERATION_TIMEOUT` (seconds) -> ms. */
export function getGenerationTimeoutMs(): number {
  return parseNumericEnv("NETRA_REDTEAM_GENERATION_TIMEOUT", DEFAULT_GENERATION_TIMEOUT_S) * 1000;
}

// ---------------------------------------------------------------------------
// Envelope unwrap + response mappers
// ---------------------------------------------------------------------------

/**
 * Unwrap the backend's `{ data: ... }` response envelope. The backend's
 * `ResponseTransformerInterceptor` wraps every response exactly once — never
 * doubly-nested — so this must NOT also unwrap an inner `data` field: some
 * payloads (e.g. the paginated results page) legitimately have their own
 * `data` field (the page's items), which an extra unwrap would silently
 * discard.
 */
export function unwrapEnvelope<T = any>(raw: any): T {
  if (raw && typeof raw === "object" && "data" in raw) {
    return raw.data as T;
  }
  return raw as T;
}

/**
 * Map a raw paginated results payload. The backend's page DTO names the
 * items field `data` (`{ data, total, page, limit, hasNextPage }`), not
 * `items` — `items` is this SDK's own `RunResultsPage` field name.
 */
export function mapResultsPage(raw: any): RunResultsPage {
  const items: RunResultItem[] = Array.isArray(raw?.data)
    ? raw.data.map((item: any) => ({
        evaluatorId: item.evaluatorId,
        evaluatorSlug: item.evaluatorSlug,
        status: item.status,
        score: item.score ?? null,
        judgeOutput: item.judgeOutput ?? null,
        sessionId: item.sessionId ?? null,
        turnIndex: item.turnIndex ?? null,
        conversationHistory: item.conversationHistory ?? [],
      }))
    : [];
  return {
    items,
    page: raw?.page ?? 1,
    limit: raw?.limit ?? items.length,
    total: raw?.total ?? items.length,
    // Backend's own field for "is there another page" (PaginatedResponseDto convention) — read
    // directly rather than inferring from a short page, which breaks if total is an exact
    // multiple of the page size. The length-based fallback only matters for a response that
    // predates this field.
    hasNextPage: raw?.hasNextPage ?? items.length >= (raw?.limit ?? 200),
  };
}

/** Map a raw risk-score payload (backend shape is `additionalProperties: true`). */
export function mapRiskScore(raw: any): RiskScore {
  return (raw ?? {}) as RiskScore;
}
