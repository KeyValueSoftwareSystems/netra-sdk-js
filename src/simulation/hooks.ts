/**
 * Pre/post script hooks for multi-turn simulation runs.
 *
 * Hooks let you run setup and teardown logic around scenario execution
 * without merging all scenarios into one or relying on sequential ordering.
 *
 * Hook levels:
 *   beforeAll  -- runs once before any scenario starts (dataset-level setup)
 *   before     -- runs before specific scenarios only (item-specific setup, keyed by datasetItemId)
 *   after      -- runs after specific scenarios only (item-specific teardown, keyed by datasetItemId)
 *   afterAll   -- runs once after all scenarios complete (dataset-level teardown)
 *
 * Execution order per item:
 *   beforeAll()                              -> returns sharedContext (Record | null)
 *   before[datasetItemId](sharedContext)     -> returns itemContext (Record | null), if registered
 *   BaseTask.run(..., setupContext)          <- receives merged context
 *   after[datasetItemId](result, setupContext), if registered
 *   afterAll(results, sharedContext)
 *
 * Failure semantics:
 *   - beforeAll failure -> entire run is marked failed (prescript_failed), no scenarios run
 *   - before failure    -> that scenario is marked failed (prescript_failed), others continue
 *   - after / afterAll failures are logged as warnings and do not affect run/scenario status
 */

import { Logger } from "../logger";

const LOG_PREFIX = "netra.simulation";

/** Hook that runs once before any scenario starts. May return shared context. */
export type BeforeAllFn = () =>
    | Record<string, any>
    | null
    | void
    | Promise<Record<string, any> | null | void>;

/** Hook that runs before a specific scenario. Receives shared context, may return item context. */
export type BeforeFn = (
    sharedContext: Record<string, any> | null,
) =>
    | Record<string, any>
    | null
    | void
    | Promise<Record<string, any> | null | void>;

/** Hook that runs after a specific scenario. Receives result and setup context. */
export type AfterFn = (
    itemResult: Record<string, any>,
    setupContext: Record<string, any> | null,
) => void | Promise<void>;

/** Hook that runs once after all scenarios complete. Receives aggregated results and shared context. */
export type AfterAllFn = (
    results: Record<string, any>,
    sharedContext: Record<string, any> | null,
) => void | Promise<void>;

/**
 * Container for lifecycle hook functions attached to a simulation run.
 *
 * All hooks are optional. When a hook is not provided the corresponding
 * lifecycle phase is silently skipped.
 */
export interface SimulationHooks {
    /** Called once before any scenario starts. May return a dict forwarded as sharedContext. */
    beforeAll?: BeforeAllFn;
    /** Dict mapping datasetItemId to hook functions. Called before specific scenarios only. */
    before?: Record<string, BeforeFn>;
    /** Dict mapping datasetItemId to hook functions. Called after specific scenarios only. */
    after?: Record<string, AfterFn>;
    /** Called once after all scenarios finish. Receives aggregated results and sharedContext. */
    afterAll?: AfterAllFn;
}

/**
 * Generate metadata describing the configured hooks for the backend.
 *
 * Run-level hooks (beforeAll / afterAll) are stored on the test run.
 * Item-level hooks (before / after) are sent under `items` keyed by datasetItemId.
 */
export function describeHooks(hooks: SimulationHooks): Record<string, any> {
    const descFn = (
        fn: ((...args: any[]) => any) | undefined,
    ): Record<string, any> | null => {
        if (!fn) return null;
        // Prefer an explicit `.description` property (JS has no runtime docstrings).
        // Falls back to null — same shape as the Python SDK's inspect.getdoc().
        const description =
            typeof (fn as any).description === "string"
                ? String((fn as any).description).slice(0, 200)
                : null;
        return {
            configured: true,
            name: fn.name || null,
            description,
        };
    };

    const payload: Record<string, any> = {};

    const beforeAllDesc = descFn(hooks.beforeAll);
    const afterAllDesc = descFn(hooks.afterAll);
    if (beforeAllDesc) payload.beforeAll = beforeAllDesc;
    if (afterAllDesc) payload.afterAll = afterAllDesc;

    const itemIds = new Set([
        ...Object.keys(hooks.before || {}),
        ...Object.keys(hooks.after || {}),
    ]);

    if (itemIds.size > 0) {
        const items: Record<string, any>[] = [];
        for (const itemId of itemIds) {
            const entry: Record<string, any> = { datasetItemId: itemId };
            const beforeDesc = descFn(hooks.before?.[itemId]);
            const afterDesc = descFn(hooks.after?.[itemId]);
            if (beforeDesc) entry.before = beforeDesc;
            if (afterDesc) entry.after = afterDesc;
            if (entry.before || entry.after) {
                items.push(entry);
            }
        }
        if (items.length > 0) {
            payload.items = items;
        }
    }

    return payload;
}

/**
 * Execute the beforeAll hook and return the shared context.
 *
 * @throws Re-raises any exception from the hook so the caller can mark the run as failed.
 */
export async function runBeforeAll(
    hooks: SimulationHooks | undefined,
): Promise<Record<string, any> | null> {
    if (!hooks?.beforeAll) return null;

    Logger.info(`${LOG_PREFIX}: running beforeAll hook`);
    const result = await hooks.beforeAll();

    if (result !== null && result !== undefined && typeof result !== "object") {
        Logger.warn(
            `${LOG_PREFIX}: beforeAll returned ${typeof result} (expected object or null); ignoring value`,
        );
        return null;
    }
    return (result as Record<string, any>) ?? null;
}

/**
 * Execute the item-specific before hook for a single scenario.
 *
 * @returns Merged context dict (sharedContext + item-specific before result),
 *          or sharedContext unchanged when no hook is registered for this item.
 * @throws Re-raises any exception so the caller can mark the scenario as prescript_failed.
 */
export async function runBefore(
    hooks: SimulationHooks | undefined,
    datasetItemId: string,
    sharedContext: Record<string, any> | null,
): Promise<Record<string, any> | null> {
    if (hooks?.before && datasetItemId in hooks.before) {
        Logger.info(
            `${LOG_PREFIX}: running before hook for datasetItemId=${datasetItemId}`,
        );
        const itemHook = hooks.before[datasetItemId];
        const result = await itemHook(sharedContext);

        const base: Record<string, any> = { ...(sharedContext || {}) };
        if (result !== null && result !== undefined) {
            if (typeof result === "object") {
                Object.assign(base, result);
            } else {
                Logger.warn(
                    `${LOG_PREFIX}: before hook returned ${typeof result} (expected object or null); ignoring value`,
                );
            }
        }
        return Object.keys(base).length > 0 ? base : null;
    }

    return sharedContext;
}

/**
 * Execute the item-specific after hook for a single scenario (best-effort).
 *
 * Called regardless of whether the scenario succeeded, failed, or had its
 * before hook fail. Exceptions are caught and logged.
 */
export async function runAfter(
    hooks: SimulationHooks | undefined,
    datasetItemId: string,
    itemResult: Record<string, any>,
    setupContext: Record<string, any> | null,
): Promise<void> {
    if (hooks?.after && datasetItemId in hooks.after) {
        Logger.info(
            `${LOG_PREFIX}: running after hook for datasetItemId=${datasetItemId}`,
        );
        try {
            await hooks.after[datasetItemId](itemResult, setupContext);
        } catch (error) {
            Logger.warn(
                `${LOG_PREFIX}: after hook raised an exception for datasetItemId=${datasetItemId} (ignored):`,
                error,
            );
        }
    }
}

/**
 * Execute the afterAll hook (best-effort).
 *
 * Exceptions are caught and logged; they do not affect the run status.
 */
export async function runAfterAll(
    hooks: SimulationHooks | undefined,
    results: Record<string, any>,
    sharedContext: Record<string, any> | null,
): Promise<void> {
    if (!hooks?.afterAll) return;

    Logger.info(`${LOG_PREFIX}: running afterAll hook`);
    try {
        await hooks.afterAll(results, sharedContext);
    } catch (error) {
        Logger.warn(
            `${LOG_PREFIX}: afterAll hook raised an exception (ignored):`,
            error,
        );
    }
}
