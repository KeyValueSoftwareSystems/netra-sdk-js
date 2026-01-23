/**
 * Evaluation Utility Functions
 */

import { propagation, context as otelContext } from "@opentelemetry/api";
import { DatasetRecord, EvaluatorConfig, ItemContext } from "./models";

/**
 * Get the session ID from the OpenTelemetry baggage
 */
export function getSessionIdFromBaggage(): string | undefined {
    const ctx = otelContext.active();
    const baggageObj = propagation.getBaggage(ctx);
    const sessionId = baggageObj?.getEntry("session_id")?.value;
    if (typeof sessionId === "string" && sessionId) {
        return sessionId;
    }
    return undefined;
}

/**
 * Format the trace ID as a 32-digit hexadecimal string
 */
export function formatTraceId(traceId: string): string {
    // Ensure it's 32 characters long, pad with zeros if needed
    return traceId.padStart(32, "0");
}

/**
 * Format the span ID as a 16-digit hexadecimal string
 */
export function formatSpanId(spanId: string): string {
    // Ensure it's 16 characters long, pad with zeros if needed
    return spanId.padStart(16, "0");
}

/**
 * Run a callable function that may be sync or async
 */
export async function runCallableMaybeAsync<T>(
    fn: (...args: any[]) => T | Promise<T>,
    ...args: any[]
): Promise<T> {
    const result = fn(...args);
    if (result instanceof Promise) {
        return await result;
    }
    return result;
}

/**
 * Extract evaluator configuration from an evaluator object
 */
export function extractEvaluatorConfig(evaluator: any): EvaluatorConfig | null {
    if (
        !evaluator ||
        typeof evaluator !== "object" ||
        !("config" in evaluator)
    ) {
        return null;
    }

    const config = evaluator.config;

    if (!config || typeof config !== "object") {
        return null;
    }

    return config as EvaluatorConfig;
}

/**
 * Execute a task function (sync or async) and return (output, status)
 */
export async function executeTask(
    task: (input: any) => any | Promise<any>,
    itemInput: any,
): Promise<{ output: any; status: string }> {
    try {
        const result = await runCallableMaybeAsync(task, itemInput);
        return { output: result, status: "completed" };
    } catch (error) {
        return { output: String(error), status: "failed" };
    }
}

/**
 * Run a single evaluator and return normalized result
 */
export async function runSingleEvaluator(params: {
    evaluator: any;
    itemInput: any;
    taskOutput: any;
    expectedOutput: any;
    metadata?: Record<string, any>;
}): Promise<Record<string, any> | null> {
    const { evaluator, itemInput, taskOutput, expectedOutput, metadata } =
        params;

    if (
        !evaluator ||
        typeof evaluator !== "object" ||
        !("evaluate" in evaluator)
    ) {
        return null;
    }

    let expectedName: string | null = null;
    const config = extractEvaluatorConfig(evaluator);
    if (config) {
        expectedName = config.name;
    }

    const context = {
        input: itemInput,
        taskOutput: taskOutput,
        expectedOutput: expectedOutput,
        metadata: metadata,
    };

    let result = evaluator.evaluate(context);
    if (result instanceof Promise) {
        result = await result;
    }

    const resultPayload = {
        evaluatorName: result.evaluatorName,
        result: result.result,
        isPassed: result.isPassed,
        reason: result.reason,
    };

    if (expectedName && resultPayload.evaluatorName !== expectedName) {
        return null;
    }

    return resultPayload;
}

/**
 * Build a payload dict for posting item status
 */
export function buildItemPayload(
    ctx: ItemContext,
    status: string,
    includeOutput: boolean = false,
): Record<string, any> {
    const payload: Record<string, any> = {
        traceId: ctx.traceId,
        sessionId: ctx.sessionId,
    };

    if (ctx.datasetItemId) {
        payload.datasetItemId = ctx.datasetItemId;
    } else {
        payload.input = ctx.itemInput;
        payload.expectedOutput = ctx.expectedOutput;
        if (ctx.metadata) {
            payload.metadata = ctx.metadata;
        }
    }

    if (ctx.status === "failed") {
        payload.status = "failed";
        return payload;
    }

    if (includeOutput) {
        payload.taskOutput = ctx.taskOutput;
    }

    return payload;
}

/**
 * Validate required inputs for runTestSuite
 */
export function validateRunInputs(
    name: string,
    data: any,
    task: ((arg: any) => any) | null | undefined,
): boolean {
    if (!name) {
        console.error("netra.evaluation: run name is required");
        return false;
    }
    if (!data) {
        console.error("netra.evaluation: data is required");
        return false;
    }
    if (task == null) {
        console.error("netra.evaluation: task function is required");
        return false;
    }
    return true;
}

/**
 * Extract datasetId from items if they are DatasetRecords
 */
export function extractDatasetId(items: any[]): string | null {
    if (items.length > 0 && isDatasetRecord(items[0])) {
        return items[0].datasetId;
    }
    return null;
}

/**
 * Type guard for DatasetRecord
 */
function isDatasetRecord(item: any): item is DatasetRecord {
    return (
        item != null &&
        typeof item === "object" &&
        "datasetId" in item &&
        typeof item.datasetId === "string"
    );
}

/**
 * Build evaluator configurations from evaluator objects
 */
export function buildEvaluatorsConfig(
    evaluators?: any[] | null,
): EvaluatorConfig[] {
    const configs: EvaluatorConfig[] = [];
    if (!evaluators || evaluators.length === 0) {
        return configs;
    }

    for (const evaluator of evaluators) {
        const config = extractEvaluatorConfig(evaluator);
        if (!config) {
            continue;
        }

        try {
            configs.push(config);
        } catch {
            continue;
        }
    }

    return configs;
}
