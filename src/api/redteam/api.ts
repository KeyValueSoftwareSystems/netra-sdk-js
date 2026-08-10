/**
 * Public API for running a red-team evaluation against a developer's local
 * agent function. Exposed as `Netra.redteam`.
 */

import pLimit from "p-limit";
import { Config } from "../../config";
import { Logger } from "../../logger";
import { RedteamHttpClient } from "./client";
import {
  CreateRunResponse,
  RedteamGenerationTimeoutError,
  RedteamResult,
  RedteamRunOptions,
  RedteamRunStatus,
  RiskScore,
  RunProgress,
  RunPromptItem,
  RunResultItem,
} from "./models";
import { executeHandler, RedteamAgentHandler } from "./task";
import { buildCreateRunBody, getGenerationPollIntervalMs, getGenerationTimeoutMs, validateRedteamInputs } from "./utils";

const LOG_PREFIX = "netra.redteam";
const MAX_AGENT_RESPONSE_CHARS = 5000;
const RESULTS_PAGE_LIMIT = 200;

/** Shared stop flag every in-flight session-drive checks between turns, so an interrupt or a fatal sibling error halts the whole run promptly. */
interface StopSignal {
  stopped: boolean;
}

/**
 * Public orchestration class for red-team runs. Owns create -> await-ready ->
 * fetch-the-whole-prompt-list-once -> drive every session's turns itself
 * (no per-turn polling, no server-side turn-state of any kind) ->
 * results/progress/risk-score aggregation.
 */
export class Redteam {
  private _config: Config;
  private _client: RedteamHttpClient;

  constructor(config: Config) {
    this._config = config;
    this._client = new RedteamHttpClient(config);
  }

  /**
   * Run a full red-team evaluation against an existing config: fetch the
   * run's entire generated prompt list once, drive every session to
   * completion itself (own local concurrency via `maxConcurrency`), then
   * fetch results + progress + risk score.
   *
   * @param options - `{configId, handler}` — `configId` identifies a
   *                  red-team config already created (e.g. in the dashboard);
   *                  `handler` is the developer's local agent callback.
   * @returns The aggregated `RedteamResult`, or `null` on invalid input /
   *          uninitialized client (logged, not thrown).
   */
  async runRedteam(options: RedteamRunOptions): Promise<RedteamResult | null> {
    if (!validateRedteamInputs(options)) {
      return null;
    }
    if (!this._client.isInitialized()) {
      Logger.error(`${LOG_PREFIX}: client not initialized (NETRA_OTLP_ENDPOINT/apiKey required)`);
      return null;
    }

    const maxConcurrency = Math.min(5, options.maxConcurrency ?? 5);

    const createResp = await this._client.createRun(buildCreateRunBody(options));

    let runId: string;
    let configId: string;
    if (createResp.status === "generating") {
      const ready = await this._awaitRunReady(createResp.configId);
      runId = ready.runId;
      configId = ready.configId;
    } else {
      runId = createResp.runId;
      configId = createResp.configId;
    }

    const stopSignal: StopSignal = { stopped: false };
    let interrupted = false;
    const proc = typeof process !== "undefined" ? process : undefined;

    const removeListeners = () => {
      if (proc && typeof proc.removeListener === "function") {
        proc.removeListener("SIGINT", handleSigint);
        proc.removeListener("SIGTERM", handleSigterm);
      }
    };

    /**
     * Single-fire interrupt finalizer: cancel the run server-side, then
     * re-deliver the signal so the process's default
     * disposition still applies once our listener is gone (matching
     * `Simulation.finalizeFailure`) — Ctrl-C still terminates the process.
     *
     * Deliberately scoped to SIGINT/SIGTERM only — NOT `uncaughtException`/
     * `unhandledRejection`. Those are process-wide events with no way to
     * tell whether the error came from this run's own session-drive loop or
     * from unrelated code elsewhere in the host process; a global listener
     * here would let any unrelated error silently cancel this run server-side
     * (and, since every concurrent `runRedteam()` call registers its own
     * listener, cancel every other in-flight run too). This run's own fatal
     * errors are already surfaced through the normal awaited chain in
     * `_driveSession`/`_driveAllSessions` — no gap this would need to fill.
     */
    const finalizeCancel = (signal: NodeJS.Signals) => {
      if (interrupted) return;
      interrupted = true;
      stopSignal.stopped = true;
      removeListeners();
      void this._client
        .cancel(runId)
        .catch((e) => {
          Logger.error(`${LOG_PREFIX}: interrupt cancel failed:`, e instanceof Error ? e.message : e);
        })
        .finally(() => {
          if (proc && typeof proc.kill === "function" && proc.pid !== undefined) {
            proc.kill(proc.pid, signal);
          }
        });
    };
    const handleSigint = () => finalizeCancel("SIGINT");
    const handleSigterm = () => finalizeCancel("SIGTERM");

    if (proc && typeof proc.once === "function") {
      proc.once("SIGINT", handleSigint);
      proc.once("SIGTERM", handleSigterm);
    }

    const promptsResp = await this._client.getPrompts(runId);
    if (promptsResp.prompts.length === 0) {
      Logger.warn(`${LOG_PREFIX}: run ${runId} has zero generated prompts — nothing to drive`);
    }

    try {
      await this._driveAllSessions(runId, options.handler, promptsResp.prompts, maxConcurrency, stopSignal);
    } finally {
      removeListeners();
    }

    const results = await this.getResults(runId);
    if (results.length === 0) {
      Logger.warn(`${LOG_PREFIX}: run ${runId} finalized with zero results`);
    }

    let progress: RunProgress | undefined;
    try {
      progress = await this._client.getProgress(runId);
    } catch (error) {
      Logger.warn(`${LOG_PREFIX}: failed to fetch progress:`, error instanceof Error ? error.message : error);
    }

    let riskScore: RiskScore | undefined;
    try {
      riskScore = await this._client.getRiskScore(configId);
    } catch (error) {
      Logger.warn(`${LOG_PREFIX}: failed to fetch risk score:`, error instanceof Error ? error.message : error);
    }

    // An interrupt always wins; otherwise re-read the run's own final status
    // (every session's last submitTurn call already finalized it server-side
    // — this is just a fresh read, not a wait).
    const status: RedteamRunStatus = interrupted ? "cancelled" : await this._finalStatus(runId);

    return {
      success: status === "completed",
      status,
      runId,
      configId,
      results,
      progress,
      riskScore,
    };
  }

  /**
   * Fetch all paginated per-turn results for a run, looping pages until a
   * short page (< limit items) is returned.
   */
  async getResults(runId: string): Promise<RunResultItem[]> {
    const items: RunResultItem[] = [];
    let page = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pageResult = await this._client.getResultsPage(runId, { page, limit: RESULTS_PAGE_LIMIT });
      items.push(...pageResult.items);
      if (pageResult.items.length < RESULTS_PAGE_LIMIT) {
        break;
      }
      page++;
    }
    return items;
  }

  /** Cancel an in-progress run. */
  async cancel(runId: string): Promise<{ status: "cancelled" }> {
    return this._client.cancel(runId);
  }

  /**
   * The "generating" gate: re-issue `createRun` with the returned `configId`
   * on a fixed interval up to a deadline, until the run is ready.
   */
  private async _awaitRunReady(
    configId: string,
  ): Promise<{ runId: string; configId: string }> {
    const intervalMs = getGenerationPollIntervalMs();
    const deadlineMs = getGenerationTimeoutMs();
    const start = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (Date.now() - start > deadlineMs) {
        throw new RedteamGenerationTimeoutError();
      }

      Logger.info(`${LOG_PREFIX}: waiting on prompt generation for config ${configId}...`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));

      const resp: CreateRunResponse = await this._client.createRun({ configId });
      if (resp.status === "running") {
        return { runId: resp.runId, configId: resp.configId };
      }
    }
  }

  /** Re-reads the run's own status once every session has been driven to completion. */
  private async _finalStatus(runId: string): Promise<RedteamRunStatus> {
    const resp = await this._client.getPrompts(runId);
    return resp.status === "generating" ? "completed" : resp.status;
  }

  /**
   * Drives every prompt's session to completion, `maxConcurrency` at a time
   * (bounded by `pLimit`). There is no server-side claim of any kind to
   * arbitrate — each prompt is driven by exactly one local worker, and no
   * other client process is racing for the same items, so `pLimit`'s own
   * queue is the only concurrency control needed.
   */
  private async _driveAllSessions(
    runId: string,
    handler: RedteamAgentHandler,
    prompts: RunPromptItem[],
    maxConcurrency: number,
    stopSignal: StopSignal,
  ): Promise<void> {
    const limit = pLimit(maxConcurrency);
    const drives = prompts.map((prompt) => limit(() => this._driveSession(runId, handler, prompt, stopSignal)));
    await Promise.all(drives);
  }

  /**
   * Drives one prompt's session from turn 1 through to `done`. Holds all
   * "what's next" state in memory (`promptText`/`turnIndex`) between
   * `submitTurn` calls — nothing is persisted server-side between turns.
   */
  private async _driveSession(
    runId: string,
    handler: RedteamAgentHandler,
    prompt: RunPromptItem,
    stopSignal: StopSignal,
  ): Promise<void> {
    // The prompt IS the session, 1:1, in this design — reusing its id as the
    // sessionId avoids inventing a second identifier for the same thing.
    let sessionId = prompt.id;
    let turnIndex = 1;
    let promptText = prompt.prompt;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (stopSignal.stopped) {
        return;
      }

      let submitBody: {
        promptId: string;
        sessionId: string;
        turnIndex: number;
        promptText: string;
        output?: string;
        error?: string;
      };
      try {
        const { output, sessionId: overrideSessionId } = await executeHandler(handler, promptText, sessionId, turnIndex);
        const truncated = this._truncateOutput(output);
        sessionId = overrideSessionId ?? sessionId;
        submitBody = { promptId: prompt.id, sessionId, turnIndex, promptText, output: truncated };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.error(`${LOG_PREFIX}: handler failed for session ${sessionId}, turn ${turnIndex}:`, message);
        submitBody = { promptId: prompt.id, sessionId, turnIndex, promptText, error: message };
      }

      let result;
      try {
        result = await this._client.submitTurn(runId, submitBody);
      } catch (error) {
        // Fatal (non-retryable/exhausted-retry) error: trip the stop signal so
        // sibling session-drives exit on their next loop check instead of
        // being orphaned, then propagate the failure to the caller.
        stopSignal.stopped = true;
        throw error;
      }

      if (result.done) {
        return;
      }

      promptText = result.nextPrompt as string;
      turnIndex = result.nextTurnIndex as number;
    }
  }

  private _truncateOutput(output: string): string {
    if (output.length <= MAX_AGENT_RESPONSE_CHARS) {
      return output;
    }
    Logger.warn(
      `${LOG_PREFIX}: agent response truncated from ${output.length} to ${MAX_AGENT_RESPONSE_CHARS} chars`,
    );
    return output.slice(0, MAX_AGENT_RESPONSE_CHARS);
  }
}
