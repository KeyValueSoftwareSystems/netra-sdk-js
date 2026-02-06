/**
 * Public API for running multi-turn conversation simulations.
 */

import pLimit from "p-limit";
import { Config } from "../config";
import { SpanWrapper } from "../span-wrapper";
import { SimulationHttpClient } from "./client";
import {
    ConversationResult,
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
            console.error(`${LOG_PREFIX}: No items returned from create_run`);
            return null;
        }

        console.info(
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
            console.info(
                `${LOG_PREFIX}: Simulation completed in ${elapsedTime} seconds`,
            );

            return result;
        } catch (error) {
            console.error(`${LOG_PREFIX}: Run simulation failed`);
            await this._client.postRunStatus(runId, "failed");
            throw error;
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
                console.info(
                    `${LOG_PREFIX}: ${processedCount}/${runItems.length} processed (run_item_id=${runItem.runItemId})`,
                );

                return result;
            }),
        );

        await Promise.all(promises);

        console.info(
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
        const { runItemId, message: initialMessage, turnId: initialTurnId } = runItem;
        let message = initialMessage;
        let turnId = initialTurnId;
        let sessionId: string | null = null;

        while (true) {
            try {
                const span = new SpanWrapper(SPAN_NAME, {}, LOG_PREFIX);
                span.start();

                const traceId = span.getCurrentSpan()?.spanContext().traceId ?? "";

                // Execute the user's task
                const [responseMessage, taskSessionId] = await executeTask(
                    task,
                    message,
                    sessionId,
                );

                if (taskSessionId) {
                    sessionId = taskSessionId;
                }

                span.end();

                // Trigger conversation with the backend
                const response = await this._client.triggerConversation(
                    responseMessage,
                    turnId,
                    sessionId || "",
                    traceId,
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
                    console.info(
                        `${LOG_PREFIX}: Completed run_item_id=${runItemId} reason=${response.reason}`,
                    );
                    return {
                        runItemId,
                        success: true,
                        finalTurnId: turnId,
                    };
                }

                // Continue to next turn
                message = response.nextUserMessage!;
                turnId = response.nextTurnId!;
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                console.error(
                    `${LOG_PREFIX}: Task failed run_item_id=${runItemId}, turn_id=${turnId}: ${errorMsg}`,
                );
                await this._client.reportFailure(runId, runItemId, errorMsg);
                return {
                    runItemId,
                    success: false,
                    error: errorMsg,
                    turnId,
                };
            }
        }
    }
}
