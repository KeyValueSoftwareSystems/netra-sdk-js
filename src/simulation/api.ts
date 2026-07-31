/**
 * Public API for running multi-turn conversation simulations.
 */

import pLimit from "p-limit";
import { Config } from "../config";
import { Logger } from "../logger";
import { SpanWrapper } from "../span-wrapper";
import { SimulationHttpClient } from "./client";
import {
    describeHooks,
    runAfter,
    runAfterAll,
    runAfterEach,
    runBefore,
    runBeforeAll,
    runBeforeEach,
    SimulationHooks,
} from "./hooks";
import {
    ConversationResult,
    FileData,
    SimulationItem,
    SimulationResult,
} from "./models";
import { BaseTask } from "./task";
import { executeTask, validateSimulationInputs } from "./utils";

const LOG_PREFIX = "netra.simulation";
const SPAN_NAME = "Netra.Simulation.TestRun";


export interface SimulationOptions {
    name: string;
    datasetId: string;
    task: BaseTask;
    context?: Record<string, any>;
    maxConcurrency?: number;  // default: 5
    hooks?: SimulationHooks;
}

/**
 * Public API for running multi-turn conversation simulations.
 */
export class Simulation {
    private _config: Config;
    private _client: SimulationHttpClient;

    constructor(config: Config) {
        this._config = config;
        this._client = new SimulationHttpClient(config);
    }

    /**
     * Run a multi-turn conversation simulation.
     *
     * Uses the two-phase API flow:
     *   1. initializeRun (no LLM cost) — with optional lifecycle hooks metadata
     *   2. beforeAll hook (if configured)
     *   3. Per-item: before hook -> generateFirstTurn -> conversation loop -> after hook
     *   4. afterAll hook (if configured)
     *
     * @param options - Simulation configuration options
     * @returns Dictionary with simulation results, or null on failure
     */
    async runSimulation(
        options: SimulationOptions,
    ): Promise<SimulationResult | null> {
        const {
            name,
            datasetId,
            task,
            context,
            maxConcurrency = 5,
            hooks,
        } = options;

        if (!validateSimulationInputs(datasetId, task)) {
            return null;
        }

        const startTime = Date.now();
        const hooksMeta = hooks ? describeHooks(hooks) : null;

        // --- Phase 1: Initialize run (DB only, no LLM) ---
        const initResult = await this._client.initializeRun(
            name,
            datasetId,
            context,
            hooksMeta && Object.keys(hooksMeta).length > 0 ? hooksMeta : null,
        );
        if (!initResult) {
            return null;
        }

        const { runId, items } = initResult;
        if (!items || items.length === 0) {
            Logger.error(`${LOG_PREFIX}: No items returned from initialize_run`);
            return null;
        }

        let interrupted = false;
        const proc = typeof process !== "undefined" ? process : undefined;
        const finalizeFailure = (signal?: NodeJS.Signals) => {
            if (interrupted) {
                return;
            }
            interrupted = true;
            proc?.removeListener("SIGINT", handleSignal);
            proc?.removeListener("SIGTERM", handleSignal);
            proc?.removeListener("uncaughtException", handleException);
            proc?.removeListener("unhandledRejection", handleRejection);
            void this._client.postRunStatus(runId, "failed").finally(() => {
                if (signal) {
                    proc?.kill(proc.pid, signal);
                }
            });
        };
        const handleSignal = (signal: "SIGINT" | "SIGTERM") => {
            finalizeFailure(signal);
        };
        const handleException = () => {
            finalizeFailure();
        };
        const handleRejection = () => {
            finalizeFailure();
        };
        if (proc && typeof proc.once === "function") {
            proc.once("SIGINT", handleSignal);
            proc.once("SIGTERM", handleSignal);
            proc.once("uncaughtException", handleException);
            proc.once("unhandledRejection", handleRejection);
        }

        try {
            // --- Phase 2: Run beforeAll hook ---
            let sharedContext: Record<string, any> | null = null;
            if (hooks?.beforeAll) {
                try {
                    sharedContext = await runBeforeAll(hooks);
                } catch (error) {
                    const errorMsg = `beforeAll hook failed: ${error instanceof Error ? error.message : String(error)}`;
                    Logger.error(`${LOG_PREFIX}: ${errorMsg} — aborting run (no LLM spent)`);

                    await this._reportFailures(
                        runId,
                        items.map((item) => item.runItemId),
                        errorMsg,
                        "prescript_failed",
                    );

                    const results: SimulationResult = {
                        success: false,
                        completed: [],
                        failed: items.map((item) => ({
                            runItemId: item.runItemId,
                            success: false,
                            error: errorMsg,
                        })),
                        totalItems: items.length,
                    };
                    try {
                        await runAfterAll(hooks, results as any, null);
                    } catch (afterAllError) {
                        // Items already marked prescript_failed — do not overwrite.
                        const afterAllMsg = `afterAll hook failed: ${afterAllError instanceof Error ? afterAllError.message : String(afterAllError)}`;
                        Logger.error(`${LOG_PREFIX}: ${afterAllMsg}`);
                    }
                    await this._client.postRunStatus(runId, "completed");
                    return results;
                }
            }

            // --- Phase 3: Run per-item before hooks + generate first turns (concurrent) ---
            const setupContexts: Map<string, Record<string, any> | null> = new Map();
            const simulationItems: SimulationItem[] = [];
            const failedItems: ConversationResult[] = [];

            const limit = pLimit(Math.min(5, maxConcurrency));
            const setupPromises = items.map((item) =>
                limit(async () => {
                    const { runItemId, datasetItemId } = item;
                    const hasBeforeHook = hooks?.before && datasetItemId in hooks.before;
                    const hasBeforeEachHook = !!hooks?.beforeEach;

                    // Track the furthest successfully built context so teardown can
                    // clean up anything beforeEach created even if before fails.
                    let setupContext: Record<string, any> | null = sharedContext;
                    if (hasBeforeEachHook || hasBeforeHook) {
                        try {
                            // beforeEach runs first for every item
                            setupContext = await runBeforeEach(hooks, datasetItemId, setupContext);
                            // then item-specific before hook (receives merged context from beforeEach)
                            setupContext = await runBefore(hooks, datasetItemId, setupContext);
                            setupContexts.set(runItemId, setupContext);
                        } catch (error) {
                            const errorMsg = `before hook failed: ${error instanceof Error ? error.message : String(error)}`;
                            Logger.error(`${LOG_PREFIX}: ${errorMsg} for runItemId=${runItemId}`);

                            await this._client.reportFailure(runId, runItemId, errorMsg, "prescript_failed");
                            const itemResult: ConversationResult = {
                                runItemId,
                                success: false,
                                error: errorMsg,
                            };
                            failedItems.push(itemResult);
                            await this._runAfterHooks(runId, runItemId, datasetItemId, hooks, itemResult as any, setupContext);
                            return;
                        }
                    } else {
                        setupContexts.set(runItemId, setupContext);
                    }

                    const simItem = await this._client.generateFirstTurn(runId, runItemId);
                    if (!simItem) {
                        Logger.warn(`${LOG_PREFIX}: Failed to generate first turn for item ${runItemId}, marking failed`);
                        await this._client.reportFailure(runId, runItemId, "Failed to generate first user message");
                        const itemResult: ConversationResult = {
                            runItemId,
                            success: false,
                            error: "Failed to generate first user message",
                        };
                        failedItems.push(itemResult);
                        await this._runAfterHooks(runId, runItemId, datasetItemId, hooks, itemResult as any, setupContexts.get(runItemId) ?? null);
                        return;
                    }

                    simulationItems.push(simItem);
                }),
            );

            await Promise.all(setupPromises);

            if (simulationItems.length === 0) {
                Logger.error(`${LOG_PREFIX}: All items failed during setup/generation`);
                const results: SimulationResult = {
                    success: false,
                    completed: [],
                    failed: failedItems,
                    totalItems: items.length,
                };
                try {
                    await runAfterAll(hooks, results as any, sharedContext);
                } catch (afterAllError) {
                    // All items already failed during setup — do not overwrite status.
                    const afterAllMsg = `afterAll hook failed: ${afterAllError instanceof Error ? afterAllError.message : String(afterAllError)}`;
                    Logger.error(`${LOG_PREFIX}: ${afterAllMsg}`);
                }
                await this._client.postRunStatus(runId, "completed");
                return results;
            }

            // --- Phase 4: Run conversation loops ---
            Logger.info(`${LOG_PREFIX}: Starting simulation with ${simulationItems.length} items`);

            try {
                const result = await this._runSimulationAsync(
                    runId,
                    simulationItems,
                    task,
                    maxConcurrency,
                    hooks,
                    sharedContext,
                    setupContexts,
                    failedItems,
                );

                const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
                Logger.info(`${LOG_PREFIX}: Simulation completed in ${elapsedTime} seconds`);

                await this._client.postRunStatus(runId, "completed");
                return result;
            } catch (error) {
                Logger.error(`${LOG_PREFIX}: Run simulation failed`);
                await this._client.postRunStatus(runId, "failed");
                throw error;
            }
        } finally {
            if (proc && typeof proc.removeListener === "function") {
                proc.removeListener("SIGINT", handleSignal);
                proc.removeListener("SIGTERM", handleSignal);
                proc.removeListener("uncaughtException", handleException);
                proc.removeListener("unhandledRejection", handleRejection);
            }
        }
    }

    /**
     * Orchestrate concurrent simulation execution with hooks support.
     */
    private async _runSimulationAsync(
        runId: string,
        runItems: SimulationItem[],
        task: BaseTask,
        maxConcurrency: number,
        hooks: SimulationHooks | undefined,
        sharedContext: Record<string, any> | null,
        setupContexts: Map<string, Record<string, any> | null>,
        setupFailedItems: ConversationResult[],
    ): Promise<SimulationResult> {
        const results: SimulationResult = {
            success: true,
            completed: [],
            failed: [],
            totalItems: runItems.length + setupFailedItems.length,
        };

        let processedCount = 0;
        const limit = pLimit(Math.min(5, maxConcurrency));

        const promises = runItems.map((runItem) =>
            limit(async () => {
                const setupContext = setupContexts.get(runItem.runItemId) ?? null;
                const result = await this._executeConversation(
                    runId,
                    runItem,
                    task,
                    hooks,
                    setupContext,
                );

                if (result.success) {
                    results.completed.push(result);
                } else {
                    results.failed.push(result);
                }

                processedCount++;
                Logger.info(
                    `${LOG_PREFIX}: ${processedCount}/${runItems.length} processed (run_item_id=${runItem.runItemId})`,
                );

                return result;
            }),
        );

        await Promise.all(promises);

        // Merge setup failures
        results.failed.push(...setupFailedItems);

        // --- afterAll ---
        try {
            await runAfterAll(hooks, results as any, sharedContext);
        } catch (error) {
            const errorMsg = `afterAll hook failed: ${error instanceof Error ? error.message : String(error)}`;
            Logger.error(`${LOG_PREFIX}: ${errorMsg}`);
            // Only mark successfully completed items — do not overwrite real failures.
            const successfulIds = results.completed.map((item) => item.runItemId);
            await this._reportFailures(runId, successfulIds, errorMsg, "postscript_failed");
        }

        Logger.info(
            `${LOG_PREFIX}: Completed=${results.completed.length}, Failed=${results.failed.length}`,
        );

        return results;
    }

    /**
     * Report failures for many items concurrently.
     */
    private async _reportFailures(
        runId: string,
        runItemIds: string[],
        error: string,
        status: string,
    ): Promise<void> {
        if (runItemIds.length === 0) {
            return;
        }
        await Promise.all(
            runItemIds.map((runItemId) =>
                this._client.reportFailure(runId, runItemId, error, status),
            ),
        );
    }

    /**
     * Run after/afterEach hooks independently.
     *
     * Both hooks always attempt to run. `postscript_failed` is reported only
     * when the item otherwise succeeded — an existing failure status/reason is
     * never overwritten.
     */
    private async _runAfterHooks(
        runId: string,
        runItemId: string,
        datasetItemId: string,
        hooks: SimulationHooks | undefined,
        itemResult: Record<string, any>,
        setupContext: Record<string, any> | null,
    ): Promise<void> {
        const errors: string[] = [];

        try {
            await runAfter(hooks, datasetItemId, itemResult, setupContext);
        } catch (error) {
            const errorMsg = `after hook failed: ${error instanceof Error ? error.message : String(error)}`;
            Logger.error(`${LOG_PREFIX}: ${errorMsg} for runItemId=${runItemId}`);
            errors.push(errorMsg);
        }

        try {
            await runAfterEach(hooks, datasetItemId, itemResult, setupContext);
        } catch (error) {
            const errorMsg = `afterEach hook failed: ${error instanceof Error ? error.message : String(error)}`;
            Logger.error(`${LOG_PREFIX}: ${errorMsg} for runItemId=${runItemId}`);
            errors.push(errorMsg);
        }

        if (errors.length > 0 && itemResult.success) {
            await this._client.reportFailure(
                runId,
                runItemId,
                errors.join("; "),
                "postscript_failed",
            );
        }
    }

    /**
     * Execute a multi-turn conversation for a single simulation item.
     *
     * The per-item before hook has already been executed by the caller;
     * the merged setupContext is passed directly to executeTask.
     * The after hook runs when the conversation ends (success or failure).
     */
    private async _executeConversation(
        runId: string,
        runItem: SimulationItem,
        task: BaseTask,
        hooks: SimulationHooks | undefined,
        setupContext: Record<string, any> | null,
    ): Promise<ConversationResult> {
        const { runItemId, datasetItemId, message: initialMessage, turnId: initialTurnId, files: initialFiles } = runItem;
        let message = initialMessage;
        let turnId = initialTurnId;
        let sessionId: string | null = null;
        let rawFiles: FileData[] = initialFiles ?? [];

        while (true) {
            const span = new SpanWrapper(
                SPAN_NAME,
                { [Config.TRACE_ORIGIN_KEY]: Config.TRACE_ORIGIN_EVALUATION },
                LOG_PREFIX,
            );
            span.start();

            try {
                const traceId = span.getCurrentSpan()?.spanContext().traceId ?? "";

                const [responseMessage, taskSessionId] = await span.withActive(
                    () => executeTask(task, message, sessionId, rawFiles, setupContext),
                );

                if (taskSessionId) {
                    sessionId = taskSessionId;
                }

                const response = await span.withActive(() =>
                    this._client.triggerConversation(
                        responseMessage,
                        turnId,
                        sessionId || "",
                        traceId,
                    ),
                );

                if (response === null) {
                    const itemResult: ConversationResult = {
                        runItemId,
                        success: false,
                        error: "Failed to get conversation response",
                        turnId,
                    };
                    await this._runAfterHooks(runId, runItemId, datasetItemId, hooks, itemResult as any, setupContext);
                    return itemResult;
                }

                if (response.decision === "stop") {
                    Logger.info(
                        `${LOG_PREFIX}: Completed run_item_id=${runItemId} reason=${response.reason}`,
                    );
                    const itemResult: ConversationResult = {
                        runItemId,
                        success: true,
                        finalTurnId: turnId,
                    };
                    await this._runAfterHooks(runId, runItemId, datasetItemId, hooks, itemResult as any, setupContext);
                    return itemResult;
                }

                message = response.nextUserMessage!;
                turnId = response.nextTurnId!;
                rawFiles = response.nextFiles || [];
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                Logger.error(
                    `${LOG_PREFIX}: Task failed run_item_id=${runItemId}, turn_id=${turnId}: ${errorMsg}`,
                );
                await this._client.reportFailure(runId, runItemId, errorMsg);
                const itemResult: ConversationResult = {
                    runItemId,
                    success: false,
                    error: errorMsg,
                    turnId,
                };
                await this._runAfterHooks(runId, runItemId, datasetItemId, hooks, itemResult as any, setupContext);
                return itemResult;
            } finally {
                span.end();
            }
        }
    }
}
