import { Logger } from "../logger";
import { BaseTask } from "./task";

const LOG_PREFIX = "netra.simulation";

/**
 * Format the trace ID as a 32-digit hexadecimal string.
 *
 * @param traceId - The integer trace ID to format
 * @returns The formatted trace ID as a hexadecimal string
 */
export function formatTraceId(traceId: number): string {
    return traceId.toString(16).padStart(32, "0");
}

/**
 * Validate required inputs for simulation.
 *
 * @param datasetId - The dataset identifier to validate
 * @param task - The task function to validate
 * @returns True if inputs are valid, false otherwise
 */
export function validateSimulationInputs(
    datasetId: string,
    task: BaseTask,
): boolean {
    if (!datasetId) {
        Logger.error(`${LOG_PREFIX}: dataset_id is required`);
        return false;
    }
    if (!(task instanceof BaseTask)) {
        Logger.error(`${LOG_PREFIX}: task must be a BaseTask instance`);
        return false;
    }
    return true;
}

/**
 * Execute a task function (sync or async) and extract message and session_id.
 *
 * @param task - The task function to execute
 * @param message - The input message to pass to the task
 * @param sessionId - The current session identifier
 * @returns A tuple of [response_message, session_id]
 * @throws Error if the task returns an unsupported type
 */
export async function executeTask(
    task: BaseTask,
    message: string,
    sessionId: string | null,
): Promise<[string, string | null]> {
    const result = task.run(message, sessionId);

    // Check if result is a Promise (async function)
    const resolvedResult = result instanceof Promise ? await result : result;

    // Validate that the result is a TaskResult
    if (
        typeof resolvedResult === "object" &&
        resolvedResult !== null &&
        "message" in resolvedResult &&
        "sessionId" in resolvedResult
    ) {
        return [resolvedResult.message, resolvedResult.sessionId];
    }

    throw new Error(
        `Task must return TaskResult, got ${typeof resolvedResult}`,
    );
}
