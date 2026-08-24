/**
 * QA fixture — NOT product source.
 *
 * A contract-faithful in-process mock of the `/redteam/sdk/*` API surface.
 * It exists so the QA E2E suite can drive the REAL `netra-sdk-js` client
 * (`RedteamHttpClient` + `Redteam`, unmocked) over a real HTTP loopback
 * connection, exercising the actual wire contract, the client-driven turn
 * loop, and error mapping end-to-end — without requiring the full backend
 * NestJS app (Postgres/ClickHouse/Redis/LLM credentials), which is
 * infeasible in this sandbox.
 *
 * This module implements the same *behavioral contract* the real backend
 * does (envelope shape, whole-list prompt fetch, per-session vs per-run
 * `done` scoping, optimistic concurrency on `turns` via duplicate-(runId,
 * promptId, turnIndex) rejection, tenant scoping) so that black-box
 * assertions made against it are meaningful re-checks of the contract, not
 * tautologies. It does not implement real judge/attacker LLM calls (there
 * are no credentials in this sandbox) — turn
 * decisions are deterministic fakes.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface MockTenant {
  apiKey: string;
  orgId: string;
  projectId: string;
  featureFlagEnabled: boolean;
}

export interface MockAgent {
  id: string;
  projectId: string;
  hasSystemPrompt: boolean;
}

export interface MockEvaluator {
  id: string;
  slug: string;
  requiresSystemPrompt: boolean;
  isJailbreak: boolean;
}

export type GenerationMode = "immediate" | "delayed" | "failed" | "unavailable";

export interface MockConfigInput {
  id?: string;
  projectId: string;
  orgId: string;
  agentId: string;
  evaluatorIds: string[];
  turnType?: "single" | "multi";
  sessionsPerEvaluator?: number;
  multiTurnCount?: number;
  generationMode?: GenerationMode;
  /** For generationMode "delayed": number of "generating" answers before flipping to "running". */
  delayedFlipAfterPolls?: number;
}

interface ConfigRecord extends Required<Omit<MockConfigInput, "delayedFlipAfterPolls">> {
  delayedFlipAfterPolls: number;
  pollCount: number;
  hasActiveRun: boolean;
}

/**
 * One generated prompt for a run — the unit of work the SDK client fetches
 * once (via `GET .../prompts`) and drives to completion itself. No
 * server-side claim/lease of any kind (revision 7 redesign): `submittedTurns`
 * only exists here to detect an exact-duplicate resubmission (409), the same
 * network-retry guard the real backend's `hasResultForTurn` check provides.
 */
interface PromptRecord {
  runId: string;
  promptId: string;
  prompt: string;
  evaluatorId: string;
  evaluatorSlug: string;
  status: "pending" | "done" | "failed";
  currentTurnIndex: number;
  priorTurns: { role: string; content: string }[];
  submittedTurns: Set<number>;
}

interface RunRecord {
  id: string;
  configId: string;
  projectId: string;
  orgId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  triggeredBy: string | null;
  promptIds: string[];
  results: any[];
}

export interface LoggedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  apiKey: string | null;
}

const EARLY_STOP_SENTINEL = "STOP_EARLY";
const JAILBREAK_CAP = 4;

export class MockRedteamBackend {
  tenants = new Map<string, MockTenant>(); // keyed by apiKey
  agents = new Map<string, MockAgent>();
  evaluators = new Map<string, MockEvaluator>();
  configs = new Map<string, ConfigRecord>();
  runs = new Map<string, RunRecord>();
  promptRecords = new Map<string, PromptRecord>(); // key `${runId}::${promptId}`

  requestLog: LoggedRequest[] = [];

  private server: http.Server;
  private _url = "";

  constructor() {
    this.server = http.createServer((req, res) => this._handle(req, res));
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address() as AddressInfo;
    this._url = `http://127.0.0.1:${addr.port}`;
    return this._url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  get url(): string {
    return this._url;
  }

  // ---------------------------------------------------------------------
  // Fixture setup helpers (used by tests to seed state)
  // ---------------------------------------------------------------------

  addTenant(t: Partial<MockTenant> = {}): MockTenant {
    const tenant: MockTenant = {
      apiKey: t.apiKey ?? `key-${randomUUID()}`,
      orgId: t.orgId ?? `org-${randomUUID()}`,
      projectId: t.projectId ?? `proj-${randomUUID()}`,
      featureFlagEnabled: t.featureFlagEnabled ?? true,
    };
    this.tenants.set(tenant.apiKey, tenant);
    return tenant;
  }

  addAgent(a: Partial<MockAgent> & { projectId: string }): MockAgent {
    const agent: MockAgent = {
      id: a.id ?? `agent-${randomUUID()}`,
      projectId: a.projectId,
      hasSystemPrompt: a.hasSystemPrompt ?? true,
    };
    this.agents.set(agent.id, agent);
    return agent;
  }

  addEvaluator(e: Partial<MockEvaluator> = {}): MockEvaluator {
    const ev: MockEvaluator = {
      id: e.id ?? `eval-${randomUUID()}`,
      slug: e.slug ?? "harmful-content",
      requiresSystemPrompt: e.requiresSystemPrompt ?? false,
      isJailbreak: e.isJailbreak ?? false,
    };
    this.evaluators.set(ev.id, ev);
    return ev;
  }

  addConfig(c: MockConfigInput): ConfigRecord {
    const record: ConfigRecord = {
      id: c.id ?? `cfg-${randomUUID()}`,
      projectId: c.projectId,
      orgId: c.orgId,
      agentId: c.agentId,
      evaluatorIds: c.evaluatorIds,
      turnType: c.turnType ?? "single",
      sessionsPerEvaluator: c.sessionsPerEvaluator ?? 1,
      multiTurnCount: c.multiTurnCount ?? 3,
      generationMode: c.generationMode ?? "immediate",
      delayedFlipAfterPolls: c.delayedFlipAfterPolls ?? 1,
      pollCount: 0,
      hasActiveRun: false,
    };
    this.configs.set(record.id, record);
    return record;
  }

  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  getConfig(configId: string): ConfigRecord | undefined {
    return this.configs.get(configId);
  }

  /** Directly seed a run's persisted result rows, bypassing the turn loop (QA-fixture-only; used for pagination-boundary testing). */
  seedRunDone(runId: string, items: any[]): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`seedRunDone: no such run ${runId}`);
    run.results.push(...items);
    run.status = "completed";
    for (const promptId of run.promptIds) {
      const record = this.promptRecords.get(`${runId}::${promptId}`);
      if (record) record.status = "done";
    }
  }

  private _attackType(config: ConfigRecord): "single" | "multi" | "jailbreak" {
    const hasJailbreak = config.evaluatorIds.some((id) => this.evaluators.get(id)?.isJailbreak);
    if (hasJailbreak) return "jailbreak";
    return config.turnType;
  }

  private _seedPromptsForRun(run: RunRecord, config: ConfigRecord): void {
    const evaluatorId = config.evaluatorIds[0];
    const evaluatorSlug = this.evaluators.get(evaluatorId)?.slug ?? "harmful-content";
    for (let i = 0; i < config.sessionsPerEvaluator; i++) {
      const promptId = `prompt-${randomUUID()}`;
      run.promptIds.push(promptId);
      this.promptRecords.set(`${run.id}::${promptId}`, {
        runId: run.id,
        promptId,
        prompt: `adversarial prompt (${promptId})`,
        evaluatorId,
        evaluatorSlug,
        status: "pending",
        currentTurnIndex: 1,
        priorTurns: [],
        submittedTurns: new Set(),
      });
    }
  }

  // ---------------------------------------------------------------------
  // HTTP handling
  // ---------------------------------------------------------------------

  private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));

    let body: any = undefined;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      body = raw ? JSON.parse(raw) : {};
    }

    const apiKey = (req.headers["x-api-key"] as string) ?? null;
    this.requestLog.push({ method: req.method ?? "", path, query, body, apiKey });

    const send = (status: number, payload: any) => {
      const json = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(json);
    };
    const ok = (data: any, meta: any = {}) => send(200, { success: true, data, error: null, meta });
    const accepted = (data: any) => send(202, { success: true, data, error: null, meta: {} });
    const errorEnv = (status: number, code: string, message: string) =>
      send(status, { success: false, data: null, error: { code, error: code, message }, meta: {} });

    try {
      if (!apiKey || !this.tenants.has(apiKey)) {
        return errorEnv(401, "UNAUTHORIZED", "missing or invalid x-api-key");
      }
      const tenant = this.tenants.get(apiKey)!;
      if (!tenant.featureFlagEnabled) {
        return errorEnv(403, "FORBIDDEN", "red-teaming not enabled for this org");
      }

      // POST /redteam/sdk/runs
      if (req.method === "POST" && path === "/redteam/sdk/runs") {
        return this._createRun(tenant, body, { ok, accepted, errorEnv });
      }

      const runMatch = path.match(/^\/redteam\/sdk\/runs\/([^/]+)\/(.+)$/);
      if (runMatch) {
        const [, runId, sub] = runMatch;
        if (req.method === "GET" && sub === "prompts") {
          return this._getPrompts(tenant, runId, { ok, errorEnv });
        }
        if (req.method === "POST" && sub === "turns") {
          return this._submitTurn(tenant, runId, body, { ok, errorEnv });
        }
        if (req.method === "GET" && sub === "progress") {
          return this._progress(tenant, runId, { ok, errorEnv });
        }
        if (req.method === "GET" && sub === "results") {
          return this._results(tenant, runId, query, { ok, errorEnv });
        }
        if (req.method === "POST" && sub === "cancel") {
          return this._cancel(tenant, runId, { ok, errorEnv });
        }
      }

      const riskMatch = path.match(/^\/redteam\/sdk\/configs\/([^/]+)\/risk-score$/);
      if (riskMatch && req.method === "GET") {
        return this._riskScore(tenant, riskMatch[1], { ok, errorEnv });
      }

      send(404, { success: false, data: null, error: { code: "NOT_FOUND", error: "NOT_FOUND", message: "no such route" }, meta: {} });
    } catch (e) {
      send(500, { success: false, data: null, error: { code: "INTERNAL", error: "INTERNAL", message: String(e) }, meta: {} });
    }
  }

  private _createRun(
    tenant: MockTenant,
    body: any,
    h: { ok: Function; accepted: Function; errorEnv: Function },
  ) {
    const hasConfigId = body && typeof body.configId === "string";
    if (!hasConfigId) {
      return h.errorEnv(400, "BAD_REQUEST", "configId is required");
    }

    const config = this.configs.get(body.configId);
    if (!config || config.projectId !== tenant.projectId) {
      return h.errorEnv(404, "NOT_FOUND", "config not found or not in this project");
    }

    // One active run per config, practically deduping repeated triggers.
    if (config.hasActiveRun) {
      return h.errorEnv(409, "CONFLICT", "a run is already active for this config");
    }

    if (config.generationMode === "unavailable") {
      return h.errorEnv(503, "SERVICE_UNAVAILABLE", "generation did not complete (worker unavailable?)");
    }
    if (config.generationMode === "failed") {
      return h.errorEnv(502, "BAD_GATEWAY", "prompt generation failed");
    }
    if (config.generationMode === "delayed") {
      config.pollCount++;
      if (config.pollCount <= config.delayedFlipAfterPolls) {
        return h.accepted({ configId: config.id, status: "generating" });
      }
      // fall through to running below (flip happens once threshold passed)
    }

    // status === 'immediate', or 'delayed' past its flip threshold: create + start the run.
    config.hasActiveRun = true;
    const run: RunRecord = {
      id: `run-${randomUUID()}`,
      configId: config.id,
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      status: "running",
      triggeredBy: null,
      promptIds: [],
      results: [],
    };
    this.runs.set(run.id, run);
    this._seedPromptsForRun(run, config);
    if (run.promptIds.length === 0) {
      // Empty run (zero prompts): nothing to service — finalize immediately.
      run.status = "completed";
    }
    return h.accepted({ runId: run.id, configId: config.id, status: "running" });
  }

  private _runFullyDone(runId: string): boolean {
    const records = [...this.promptRecords.values()].filter((r) => r.runId === runId);
    if (records.length === 0) {
      // No prompts were ever seeded for this run (empty run) — done
      // iff the run itself was already finalized at creation time.
      const run = this.runs.get(runId);
      return !!run && run.status !== "running";
    }
    return records.every((r) => r.status === "done" || r.status === "failed");
  }

  /**
   * `GET .../prompts` — the client fetches this ONCE per run, then drives
   * every prompt's session to completion itself. No server-side claim of any
   * kind (revision 7 redesign).
   */
  private _getPrompts(tenant: MockTenant, runId: string, h: { ok: Function; errorEnv: Function }) {
    const run = this.runs.get(runId);
    if (!run || run.projectId !== tenant.projectId) return h.errorEnv(404, "NOT_FOUND", "run not found");
    const config = this.configs.get(run.configId)!;
    const prompts = run.promptIds.map((promptId) => {
      const record = this.promptRecords.get(`${runId}::${promptId}`)!;
      return {
        id: record.promptId,
        prompt: record.prompt,
        evaluatorId: record.evaluatorId,
        evaluatorSlug: record.evaluatorSlug,
      };
    });
    h.ok({
      runId,
      status: run.status,
      turnType: config.turnType,
      multiTurnCount: config.multiTurnCount,
      prompts,
    });
  }

  /**
   * `POST .../turns` — submits one turn's result for one prompt/session,
   * identified directly by `promptId` (no server-issued invocation id, no
   * persisted turn-state). Prior turns are reconstructed from this prompt's
   * own accumulated `priorTurns`, mirroring how the real backend rebuilds
   * them from `redteam_run_results` rows.
   */
  private _submitTurn(tenant: MockTenant, runId: string, body: any, h: { ok: Function; errorEnv: Function }) {
    const run = this.runs.get(runId);
    if (!run || run.projectId !== tenant.projectId) return h.errorEnv(404, "NOT_FOUND", "run not found");
    if (!body || typeof body.promptId !== "string" || typeof body.turnIndex !== "number") {
      return h.errorEnv(422, "UNPROCESSABLE", "promptId and turnIndex required");
    }
    if (body.output === undefined && body.error === undefined) {
      return h.errorEnv(422, "UNPROCESSABLE", "neither output nor error supplied");
    }

    const record = this.promptRecords.get(`${runId}::${body.promptId}`);
    if (!record) {
      return h.errorEnv(404, "NOT_FOUND", "promptId does not belong to this runId");
    }
    if (record.submittedTurns.has(body.turnIndex)) {
      // Exact-duplicate submission (network-retry guard) — 409, matching the
      // real backend's `hasResultForTurn` check.
      return h.errorEnv(409, "CONFLICT", "this turn has already been submitted");
    }
    record.submittedTurns.add(body.turnIndex);

    const config = this.configs.get(run.configId)!;
    const attackType = this._attackType(config);

    const output = body.error !== undefined ? `[error: ${body.error}]` : String(body.output);
    run.results.push({
      evaluatorId: record.evaluatorId,
      evaluatorSlug: record.evaluatorSlug,
      status: body.error !== undefined ? "error" : "pass",
      score: body.error !== undefined ? null : 1,
      judgeOutput: body.error !== undefined ? `handler error: ${body.error}` : "no leak detected",
      sessionId: body.sessionId,
      turnIndex: body.turnIndex,
      conversationHistory: [
        { role: "user", content: body.promptText },
        { role: "assistant", content: output },
      ],
    });
    record.priorTurns.push({ role: "user", content: body.promptText }, { role: "assistant", content: output });

    if (body.error !== undefined) {
      record.status = "failed";
      if (this._runFullyDone(runId)) {
        run.status = "completed";
        run.triggeredBy = "org-owner-fixture";
      }
      return h.ok({ done: true });
    }

    const cap = attackType === "jailbreak" ? JAILBREAK_CAP : attackType === "multi" ? config.multiTurnCount : 1;
    const earlyStop = typeof body.output === "string" && body.output.includes(EARLY_STOP_SENTINEL);

    let done: boolean;
    let nextPrompt: string | undefined;
    let nextTurnIndex: number | undefined;
    if (earlyStop || body.turnIndex >= cap) {
      record.status = "done";
      done = true;
    } else {
      record.currentTurnIndex = body.turnIndex + 1;
      nextPrompt = `adversarial prompt turn ${record.currentTurnIndex} (${record.promptId})`;
      nextTurnIndex = record.currentTurnIndex;
      done = false;
    }

    // Recompute run-level completion for observability/cancel semantics.
    if (this._runFullyDone(runId)) {
      run.status = "completed";
      run.triggeredBy = "org-owner-fixture";
    }

    return h.ok(done ? { done: true } : { done: false, nextPrompt, nextTurnIndex });
  }

  private _progress(tenant: MockTenant, runId: string, h: { ok: Function; errorEnv: Function }) {
    const run = this.runs.get(runId);
    if (!run || run.projectId !== tenant.projectId) return h.errorEnv(404, "NOT_FOUND", "run not found");
    const total = run.promptIds.length;
    const doneCount = [...this.promptRecords.values()].filter((r) => r.runId === runId && r.status === "done").length;
    h.ok({ runId, status: run.status, totalSessions: total, completedSessions: doneCount });
  }

  private _results(tenant: MockTenant, runId: string, query: Record<string, string>, h: { ok: Function; errorEnv: Function }) {
    const run = this.runs.get(runId);
    if (!run || run.projectId !== tenant.projectId) return h.errorEnv(404, "NOT_FOUND", "run not found");
    const page = Number(query.page ?? "1");
    const limit = Number(query.limit ?? "200");
    const start = (page - 1) * limit;
    const items = run.results.slice(start, start + limit);
    // Field name is `data` (matching the real backend's paginated response DTO), not `items` —
    // `items` is this SDK's own post-mapping `RunResultsPage` field name (see mapResultsPage).
    h.ok({ data: items, page, limit, total: run.results.length, hasNextPage: start + limit < run.results.length });
  }

  private _riskScore(tenant: MockTenant, configId: string, h: { ok: Function; errorEnv: Function }) {
    const config = this.configs.get(configId);
    if (!config || config.projectId !== tenant.projectId) return h.errorEnv(404, "NOT_FOUND", "config not found");
    h.ok({ configId, latestSafetyScore: 92, change: -3, history: [{ at: new Date().toISOString(), score: 92 }] });
  }

  private _cancel(tenant: MockTenant, runId: string, h: { ok: Function; errorEnv: Function }) {
    const run = this.runs.get(runId);
    if (!run || run.projectId !== tenant.projectId) return h.errorEnv(404, "NOT_FOUND", "run not found");
    if (run.status !== "running") {
      return h.errorEnv(409, "CONFLICT", "run is not currently RUNNING");
    }
    run.status = "cancelled";
    for (const promptId of run.promptIds) {
      const record = this.promptRecords.get(`${runId}::${promptId}`);
      if (record) record.status = "done";
    }
    const config = this.configs.get(run.configId);
    if (config) config.hasActiveRun = false;
    h.ok({ status: "cancelled" });
  }
}
