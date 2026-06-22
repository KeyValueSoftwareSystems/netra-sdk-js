/**
 * Public API for running multi-turn conversation simulations.
 */

import pLimit from "p-limit";
import { Config } from "../config";
import { Logger } from "../logger";
import { SpanWrapper } from "../span-wrapper";
import { SimulationHttpClient } from "./client";
import {
    ConversationResult,
    FileData,
    Initiator,
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
        } = options;

        if (!validateSimulationInputs(datasetId, task)) {
            return null;
        }

        const startTime = Date.now();
        const runResult = await this._client.createRun(name, datasetId, context);
        if (!runResult) {
            return null;
        }

        const { runId, simulationItems } = runResult;
        if (!simulationItems || simulationItems.length === 0) {
            Logger.error(`${LOG_PREFIX}: No items returned from create_run`);
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

        Logger.info(
            `${LOG_PREFIX}: Starting simulation with ${simulationItems.length} items`,
        );

        try {
            const result = await this._runSimulationAsync(
                runId,
                simulationItems,
                task,
                maxConcurrency,
            );

            const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
            Logger.info(
                `${LOG_PREFIX}: Simulation completed in ${elapsedTime} seconds`,
            );

            return result;
        } catch (error) {
            Logger.error(`${LOG_PREFIX}: Run simulation failed`);
            await this._client.postRunStatus(runId, "failed");
            throw error;
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
     * Async implementation of run_simulation with concurrency control.
     */
    private async _runSimulationAsync(
        runId: string,
        runItems: SimulationItem[],
        task: BaseTask,
        maxConcurrency: number,
    ): Promise<SimulationResult> {
        const results: SimulationResult = {
            success: true,
            completed: [],
            failed: [],
            totalItems: runItems.length,
        };

        let processedCount = 0;

        // Create concurrency limiter
        const limit = pLimit(Math.min(5, maxConcurrency));

        // Process items with concurrency control
        const promises = runItems.map((runItem) =>
            limit(async () => {
                const result = await this._executeConversation(runId, runItem, task);

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

        Logger.info(
            `${LOG_PREFIX}: Completed=${results.completed.length}, Failed=${results.failed.length}`,
        );

        await this._client.postRunStatus(runId, "completed");

        return results;
    }

    /**
     * Execute a multi-turn conversation for a single simulation item.
     */
    private async _executeConversation(
        runId: string,
        runItem: SimulationItem,
        task: BaseTask,
    ): Promise<ConversationResult> {
        const { runItemId, message: initialMessage, turnId: initialTurnId, files: initialFiles } = runItem;

        let initiator: Initiator = initialMessage === null ? "agent" : "user";
        let message = initialMessage ?? "";
        let turnId = initialTurnId;
        let sessionId: string | null = null;
        let rawFiles: FileData[] = initialFiles ?? [];

        while (true) {
            const span = new SpanWrapper(SPAN_NAME, {}, LOG_PREFIX);
            span.start();

            try {
                const traceId = span.getCurrentSpan()?.spanContext().traceId ?? "";

                const [responseMessage, taskSessionId] = await span.withActive(
                    () => executeTask(task, message, sessionId, rawFiles, initiator),
                );

                if (taskSessionId) {
                    sessionId = taskSessionId;
                }

                // Trigger conversation inside the same active context so the
                // axios interceptor injects the correct traceparent header.
                const response = await span.withActive(() =>
                    this._client.triggerConversation(
                        responseMessage,
                        turnId,
                        sessionId || "",
                        traceId,
                    ),
                );

                if (response === null) {
                    const errorMsg = "Failed to get conversation response";
                    return {
                        runItemId,
                        success: false,
                        error: errorMsg,
                        turnId,
                    };
                }

                if (response.decision === "stop") {
                    Logger.info(
                        `${LOG_PREFIX}: Completed run_item_id=${runItemId} reason=${response.reason}`,
                    );
                    return {
                        runItemId,
                        success: true,
                        finalTurnId: turnId,
                    };
                }

                message = response.nextUserMessage ?? "";
                turnId = response.nextTurnId!;
                rawFiles = response.nextFiles || [];
                initiator = !message  ? "agent" : "user";
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                Logger.error(
                    `${LOG_PREFIX}: Task failed run_item_id=${runItemId}, turn_id=${turnId}: ${errorMsg}`,
                );
                await this._client.reportFailure(runId, runItemId, errorMsg);
                return {
                    runItemId,
                    success: false,
                    error: errorMsg,
                    turnId,
                };
            } finally {
                span.end();
            }
        }
    }
}
