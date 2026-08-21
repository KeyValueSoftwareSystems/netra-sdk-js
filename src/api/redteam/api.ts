/**
 * Public API for running a red-team evaluation against a developer's local
 * agent function. Exposed as `Netra.redteam`.
 */

import pLimit from "p-limit";
import { Config } from "../../config";
import { Logger } from "../../logger";
import { RootSpanProcessor } from "../../processors/root-span-processor";
import { SpanWrapper } from "../../span-wrapper";
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
import { registerShutdownHook } from "../../utils/shutdown-hooks";

const LOG_PREFIX = "netra.redteam";
const MAX_AGENT_RESPONSE_CHARS = 5000;
const TURN_SPAN_NAME = "Netra.Redteam.Turn";
// Same attribute/value the backend already sets on its own redteam-originated
// spans and already filters on for Insights/auto-eval — stamping it here too
// so traces produced by the developer's own instrumented handler get excluded
// the same way.
const TRACE_ORIGIN_ATTRIBUTE = "netra.trace.origin";
const TRACE_ORIGIN_REDTEAM = "redteam";
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

    /**
     * Cancels the run server-side on shutdown — see ../../utils/shutdown-hooks.ts.
     * Deliberately not hooked into uncaughtException/unhandledRejection: those
     * are process-wide, so reacting to them here could cancel unrelated
     * concurrent runs too. This run's own errors already surface through
     * _driveSession/_driveAllSessions.
     */
    const unregisterShutdownHook = registerShutdownHook(async () => {
      if (interrupted) return;
      interrupted = true;
      stopSignal.stopped = true;
      try {
        await this._client.cancel(runId);
        Logger.debug(`${LOG_PREFIX}: run ${runId} cancelled server-side`);
      } catch (e) {
        Logger.error(`${LOG_PREFIX}: interrupt cancel failed:`, e instanceof Error ? e.message : e);
      }
    });

    const promptsResp = await this._client.getPrompts(runId);
    if (promptsResp.prompts.length === 0) {
      Logger.warn(`${LOG_PREFIX}: run ${runId} has zero generated prompts — nothing to drive`);
    }

    try {
      await this._driveAllSessions(runId, options.handler, promptsResp.prompts, maxConcurrency, stopSignal);
    } finally {
      unregisterShutdownHook();
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

    const runNumber = typeof progress?.runNumber === "number" ? progress.runNumber : undefined;

    return {
      success: status === "completed",
      status,
      runId,
      configId,
      runNumber,
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
      // Wrap the handler call in its own span (mirroring simulation's per-turn
      // span) so there's always a root span to tag — the developer's own
      // instrumentation may not start one on its own (e.g. a plain fetch to
      // their agent with no outer span active).
      const turnSpan = new SpanWrapper(TURN_SPAN_NAME, {}, LOG_PREFIX);
      turnSpan.start();
      try {
        const { output, sessionId: overrideSessionId } = await turnSpan.withActive(() => {
          RootSpanProcessor.setAttributeOnRootSpan(TRACE_ORIGIN_ATTRIBUTE, TRACE_ORIGIN_REDTEAM);
          return executeHandler(handler, promptText, sessionId, turnIndex);
        });
        const truncated = this._truncateOutput(output);
        sessionId = overrideSessionId ?? sessionId;
        submitBody = { promptId: prompt.id, sessionId, turnIndex, promptText, output: truncated };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.error(`${LOG_PREFIX}: handler failed for session ${sessionId}, turn ${turnIndex}:`, message);
        submitBody = { promptId: prompt.id, sessionId, turnIndex, promptText, error: message };
      } finally {
        turnSpan.end();
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
