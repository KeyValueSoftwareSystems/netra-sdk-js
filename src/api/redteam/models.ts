/**
 * Public + wire types for the red-team SDK client.
 */

import { RedteamAgentHandler } from "./task";

/** The attack style a run's underlying config was set up with. */
export type RedteamTurnType = "single" | "multi";

/** Server-side run lifecycle status. */
export type RedteamRunStatus = "running" | "completed" | "failed" | "cancelled";

// ---------------------------------------------------------------------------
// Public input
// ---------------------------------------------------------------------------

/**
 * Options for `Netra.redteam.runRedteam()` — triggers a red-team run against a
 * config that already exists (created ahead of time in the dashboard: agent,
 * evaluators, attack settings are all decided there). The SDK only drives the
 * run; it never creates or edits the config.
 */
export interface RedteamRunOptions {
  /** The id of an existing red-team config to run. */
  configId: string;
  /** The developer's local agent callback — a PLAIN function. */
  handler: RedteamAgentHandler;
  /** Client-side session concurrency; default 5, capped at 5. */
  maxConcurrency?: number;
}

// ---------------------------------------------------------------------------
// Wire (request) types — exact backend field names
// ---------------------------------------------------------------------------

/** Wire body for `POST .../runs`. */
export interface CreateRunRequestBody {
  configId: string;
}

/**
 * Wire body for `POST .../turns` — submits one turn's result for one session, identified
 * directly by `promptId` (from `GET .../prompts`; there is no server-issued invocation id).
 */
export interface SubmitTurnBody {
  promptId: string;
  sessionId: string;
  turnIndex: number;
  /** What was actually sent to the agent THIS turn — the catalog prompt verbatim on turn 1, or the previous call's `nextPrompt` for turn > 1. */
  promptText: string;
  output?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Wire (response) types
// ---------------------------------------------------------------------------

export interface CreateRunRunningResponse {
  runId: string;
  configId: string;
  status: "running";
}

export interface CreateRunGeneratingResponse {
  configId: string;
  status: "generating";
}

export type CreateRunResponse =
  | CreateRunRunningResponse
  | CreateRunGeneratingResponse;

export interface ConversationTurn {
  role: string;
  content: string;
}

/** One generated attack prompt — the unit of work the client drives to completion itself. */
export interface RunPromptItem {
  id: string;
  prompt: string;
  evaluatorId: string;
  evaluatorSlug: string;
}

/**
 * `GET .../prompts` response — the client fetches this ONCE per run, then drives every
 * session's turns itself (its own local concurrency, its own in-memory "what's next" state).
 * No per-session claim/lease exists server-side; there is no other client racing for the same
 * items, so no server-side arbitration is needed.
 */
export interface RunPromptsResponse {
  runId: string;
  status: RedteamRunStatus | "generating";
  turnType: RedteamTurnType;
  multiTurnCount: number;
  prompts: RunPromptItem[];
}

export interface SubmitTurnResult {
  /** True if this session is finished. */
  done: boolean;
  /** Present when done=false — the next message to send to the agent. */
  nextPrompt?: string;
  /** Present when done=false. */
  nextTurnIndex?: number;
}

/** Reused `RunProgressResponse` shape from the existing UI-facing service. */
export type RunProgress = Record<string, unknown>;

export interface RunResultItem {
  evaluatorId: string;
  evaluatorSlug?: string;
  status: "pass" | "fail" | "error";
  score?: number | null;
  judgeOutput?: string | null;
  sessionId?: string | null;
  turnIndex?: number | null;
  conversationHistory?: ConversationTurn[];
}

export interface RunResultsPage {
  items: RunResultItem[];
  page: number;
  limit: number;
  total: number;
}

/** Reused `RiskScoreResponse` shape. */
export type RiskScore = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Public output — the developer-facing result
// ---------------------------------------------------------------------------

export interface RedteamResult {
  success: boolean;
  status: RedteamRunStatus;
  runId: string;
  configId: string;
  results: RunResultItem[];
  progress?: RunProgress;
  riskScore?: RiskScore;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** 401 — missing/invalid `x-api-key`. */
export class RedteamAuthError extends Error {
  constructor(message = "check NETRA_API_KEY") {
    super(message);
    this.name = "RedteamAuthError";
  }
}

/** 400/404/422 — bad/unknown config, agent, or evaluator ids. */
export class RedteamConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedteamConfigError";
  }
}

/** 502 — prompt generation failed. */
export class RedteamGenerationError extends Error {
  constructor(message = "prompt generation failed") {
    super(message);
    this.name = "RedteamGenerationError";
  }
}

/** Generation deadline exceeded / 503 poll-budget exhausted. */
export class RedteamGenerationTimeoutError extends Error {
  constructor(message = "generation did not complete (worker unavailable?)") {
    super(message);
    this.name = "RedteamGenerationTimeoutError";
  }
}

/** 409 — active-run conflict, or other run-level failure. */
export class RedteamRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedteamRunError";
  }
}
