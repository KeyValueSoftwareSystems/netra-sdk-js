/**
 * Single owner of the SDK's exit-deciding process listeners.
 *
 * Components that need to finish async work before the host process goes away
 * register a task here instead of installing their own `process` listeners.
 * Having one owner is the point: when two listeners each decided for themselves
 * whether to re-raise a signal, the faster one killed the process while the
 * slower one was still mid-request.
 *
 * The SDK never decides when (or with which code) the process exits. Once the
 * registered tasks have run, Node's default behaviour is restored only if the
 * application is not handling the event itself.
 */

import { Logger } from "./logger";

/**
 * Budget for the trace flush inside `Netra.shutdown()`.
 */
export const FLUSH_TIMEOUT_MS = 5000;

/**
 * Budget for *all* registered exit tasks combined. It must strictly dominate
 * `FLUSH_TIMEOUT_MS`: `Netra.shutdown()` does unbudgeted work either side of
 * its own flush race, so a budget equal to the inner one would expire first and
 * truncate the very flush it is meant to protect.
 */
export const EXIT_BUDGET_MS = FLUSH_TIMEOUT_MS + 2000;

export type ExitReason =
    | { kind: "signal"; signal: NodeJS.Signals }
    | { kind: "uncaughtException"; error: unknown }
    | { kind: "unhandledRejection"; error: unknown }
    | { kind: "shutdown" };

export type ExitTask = (reason: ExitReason) => unknown | Promise<unknown>;

export interface ExitTaskOptions {
    /**
     * Also run this task on `unhandledRejection`. Off by default and
     * deliberately opt-in: merely having an `unhandledRejection` listener
     * suppresses Node's default crash behaviour, so the SDK must not arm one
     * for every consumer just because something registered a task.
     */
    unhandledRejection?: boolean;
}

interface Entry {
    task: ExitTask;
    unhandledRejection: boolean;
}

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

const entries = new Set<Entry>();
/** Our own listener functions, so we can tell them apart from the app's. */
const ours = new Set<unknown>();
/**
 * Whether the app already had a listener for a signal when we installed ours.
 * Apps that use `process.once` have their listener removed by Node before any
 * handler runs, so by the time we look it is gone; this is the only chance we
 * get to notice it.
 */
const appHadListener = new Map<NodeJS.Signals, boolean>();

/**
 * Tasks currently running as part of a fire, so `settleOtherExitTasks` can wait
 * for them. Needed because the host application typically shuts down with
 * `await Netra.shutdown(); process.exit(0)` — if `shutdown()` resolves while a
 * sibling task (e.g. the simulation run-status post) is still in flight, the
 * application exits and truncates it.
 */
let inFlight: Array<{ task: ExitTask; promise: Promise<unknown> }> = [];

let installed = false;
let rejectionInstalled = false;
/** A shutdown is in progress: tasks are running and an exit decision is pending. */
let firing = false;
/** We are deliberately rethrowing a rejection to restore Node's default. */
let rethrowing = false;
/**
 * Identifies the current shutdown. Bumped when a fire starts and again when one
 * is superseded (a second signal), so a superseded fire's `.finally` can tell
 * that it no longer owns the exit decision and must not act on it.
 */
let generation = 0;

/**
 * Register work to run before the process goes away. Returns a function that
 * unregisters it; call it when the work is no longer relevant (e.g. the
 * simulation run finished normally).
 */
export function registerExitTask(
    task: ExitTask,
    options: ExitTaskOptions = {},
): () => void {
    const entry: Entry = {
        task,
        unhandledRejection: options.unhandledRejection === true,
    };
    entries.add(entry);
    install();
    return () => {
        entries.delete(entry);
        // Never tear down listeners mid-shutdown: a task that unregisters
        // itself (Netra.shutdown() does, via _removeShutdownHooks) would
        // otherwise strip the protection from tasks still running beside it.
        if (entries.size === 0 && !firing) {
            uninstall();
        } else {
            syncRejectionListener();
        }
    };
}

function install(): void {
    // Registration during a shutdown is best-effort: the `.finally` below is
    // about to uninstall everything, so re-arming here would only leave the
    // new task unprotected and confuse the exit decision.
    if (firing) {
        return;
    }
    if (!installed) {
        installed = true;
        for (const sig of SIGNALS) {
            appHadListener.set(sig, process.listenerCount(sig) > 0);
            process.on(sig, onSignal);
        }
        process.on("uncaughtException", onUncaughtException);
        ours.add(onSignal);
        ours.add(onUncaughtException);
    }
    syncRejectionListener();
}

function syncRejectionListener(): void {
    if (!installed) {
        return;
    }
    const wanted = [...entries].some((e) => e.unhandledRejection);
    if (wanted && !rejectionInstalled) {
        rejectionInstalled = true;
        process.on("unhandledRejection", onUnhandledRejection);
        ours.add(onUnhandledRejection);
    } else if (!wanted && rejectionInstalled) {
        rejectionInstalled = false;
        process.removeListener("unhandledRejection", onUnhandledRejection);
        ours.delete(onUnhandledRejection);
    }
}

/** Idempotent: called both mid-fire and from the `.finally` of a fire. */
function uninstall(): void {
    if (rejectionInstalled) {
        rejectionInstalled = false;
        process.removeListener("unhandledRejection", onUnhandledRejection);
    }
    if (!installed) {
        return;
    }
    installed = false;
    for (const sig of SIGNALS) {
        process.removeListener(sig, onSignal);
    }
    process.removeListener("uncaughtException", onUncaughtException);
    ours.clear();
    appHadListener.clear();
}

/**
 * Does the *application* handle this event, as opposed to us? Sampled at
 * handler entry rather than after the tasks have run, so a handler that
 * removes itself during shutdown cannot trick us into killing the process
 * out from under it.
 */
function appHandles(event: NodeJS.Signals | "uncaughtException"): boolean {
    const live = process
        .listeners(event)
        .some((l) => !ours.has(l));
    if (live) {
        return true;
    }
    return event !== "uncaughtException" && appHadListener.get(event) === true;
}

async function runTasks(reason: ExitReason): Promise<void> {
    const pending = [...entries];
    // Remove only what we are about to run, never the whole set: each task
    // runs at most once, and one registered while this batch is running must
    // stay registered.
    pending.forEach((e) => entries.delete(e));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, EXIT_BUDGET_MS);
        // Don't let the budget timer itself keep the process alive.
        timer.unref?.();
    });

    // `Promise.resolve().then` so a task that throws synchronously is captured
    // by allSettled instead of escaping as a rejection.
    const running = pending.map((e) => ({
        task: e.task,
        promise: Promise.resolve().then(() => e.task(reason)) as Promise<unknown>,
    }));
    running.forEach((r) => r.promise.catch(() => {}));
    inFlight = running;

    try {
        await Promise.race([
            Promise.allSettled(running.map((r) => r.promise)),
            budget,
        ]);
    } finally {
        clearTimeout(timer);
        inFlight = inFlight.filter((r) => !running.includes(r));
    }
}

/**
 * Wait for every registered exit task except `exclude` to finish, starting any
 * that have not run yet.
 *
 * `Netra.shutdown()` calls this with its own flush task excluded, so that the
 * public "I am shutting down" promise does not resolve while another task is
 * still mid-request. Excluding the caller's own task is what keeps this from
 * deadlocking, since the flush task *is* `Netra.shutdown()`.
 */
export async function settleOtherExitTasks(exclude: ExitTask): Promise<void> {
    const others = inFlight
        .filter((r) => r.task !== exclude)
        .map((r) => r.promise);

    // Tasks registered but not yet fired: a direct `Netra.shutdown()` with no
    // signal involved still needs to run them.
    const notYetRun = [...entries].filter((e) => e.task !== exclude);
    notYetRun.forEach((e) => entries.delete(e));
    const started = notYetRun.map((e) => {
        const p = Promise.resolve().then(() => e.task({ kind: "shutdown" }));
        p.catch(() => {});
        return p as Promise<unknown>;
    });

    const all = [...others, ...started];
    if (all.length === 0) {
        return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, EXIT_BUDGET_MS);
        timer.unref?.();
    });
    try {
        await Promise.race([Promise.allSettled(all), budget]);
    } finally {
        clearTimeout(timer);
    }
}

const onSignal = (sig: NodeJS.Signals): void => {
    if (firing) {
        // A second signal means "I meant it". Stop protecting the process and
        // let the signal take its default disposition; the in-flight tasks are
        // abandoned deliberately.
        Logger.debug(`netra: second ${sig} during shutdown; exiting now`);
        // Only listeners still attached count here, not `appHandles`: its
        // `appHadListener` fallback is stale by now. An app that removes its
        // own handler and re-sends the signal (NestJS does this) has handed
        // the decision back; trusting the stale flag would leave nobody to
        // re-raise and the process would hang until SIGKILL.
        const handled = process.listeners(sig).some((l) => !ours.has(l));
        // Supersede the in-flight fire so its `.finally` does not re-raise
        // again once its abandoned tasks eventually settle.
        generation++;
        firing = false;
        uninstall();
        if (!handled) {
            try {
                process.kill(process.pid, sig);
            } catch {
                // Nothing more we can do; let the process continue.
            }
        }
        return;
    }
    firing = true;
    const gen = ++generation;
    const handled = appHandles(sig);
    Logger.log(`\nReceived ${sig}. Flushing Netra SDK...`);
    void runTasks({ kind: "signal", signal: sig })
        .catch((err) => Logger.error("netra: error during shutdown:", err))
        .finally(() => {
            if (gen !== generation) {
                return; // superseded by a later signal
            }
            uninstall();
            firing = false;
            if (!handled) {
                try {
                    process.kill(process.pid, sig);
                } catch {
                    // Ignore: the process may already be going away.
                }
            }
        });
};

const onUncaughtException = (error: Error): void => {
    if (rethrowing) {
        // Our own deliberate rethrow of an unhandled rejection. Stay out of
        // the way so it gets Node's default disposition. Consume the flag here
        // rather than where it is set: the throw unwinds before Node emits
        // this event, so resetting it any earlier would clear it too soon.
        rethrowing = false;
        return;
    }
    if (firing) {
        // A crash while we were already shutting down. If the application has
        // its own handler it owns the decision, exactly as it would without
        // us — forcing an exit here would kill it mid-cleanup.
        if (appHandles("uncaughtException")) {
            return;
        }
        // Nothing else handles this. Our listener is still attached, so Node
        // will not act on it either; returning would leave the error neither
        // logged nor fatal and the process limping on in a broken state.
        uninstall();
        console.error(error);
        process.exitCode = 1;
        setImmediate(() => process.exit(1));
        return;
    }
    if (appHandles("uncaughtException")) {
        // The application owns this event and may well carry on running, so
        // the process is not necessarily going away. Firing here would burn
        // the one-shot exit tasks and tear down our listeners, leaving the SDK
        // disarmed: a later SIGTERM would then flush nothing. Stay out of it.
        return;
    }
    firing = true;
    const gen = ++generation;
    Logger.error("Uncaught exception; flushing Netra SDK before exit...");
    void runTasks({ kind: "uncaughtException", error })
        .catch((err) => Logger.error("netra: error during crash shutdown:", err))
        .finally(() => {
            if (gen !== generation) {
                return;
            }
            uninstall();
            firing = false;
            // Mirror Node's default: print the error and exit with code 1.
            // `exitCode` + a deferred `exit` so the stderr write gets a turn
            // before the process goes away.
            console.error(error);
            process.exitCode = 1;
            setImmediate(() => process.exit(1));
        });
};

const onUnhandledRejection = (reason: unknown): void => {
    if (firing) {
        return;
    }

    // Does the application listen for rejections? If so it owns the event
    // completely: Node would not crash, nothing is shutting down, and firing
    // here would burn the one-shot exit tasks. Observed live: a rejection the
    // app recovered from marked a healthy simulation run "failed" before the
    // run went on to complete.
    const rejHandled = process
        .listeners("unhandledRejection")
        .some((l) => !ours.has(l));
    if (rejHandled) {
        return;
    }

    // Nothing listens for rejections, so Node's behaviour is to raise this as
    // an uncaught exception. Whether that ends the process depends on whether
    // anything handles *that*.
    if (!appHandles("uncaughtException")) {
        firing = true;
        const gen = ++generation;
        void runTasks({ kind: "unhandledRejection", error: reason })
            .catch((err) => Logger.error("netra: error during shutdown:", err))
            .finally(() => {
                if (gen !== generation) {
                    return;
                }
                firing = false;
                uninstall();
                rethrow(reason);
            });
        return;
    }

    // An application `uncaughtException` handler will catch the rethrow and
    // carry on, so the process survives. Preserve Node's semantics without
    // treating this as a shutdown.
    rethrow(reason);
};

/**
 * Restore Node's default disposition for an unhandled rejection.
 *
 * A bare `throw` here would become another rejected promise and re-enter the
 * handler above; throwing from `setImmediate` surfaces as a genuine uncaught
 * exception instead. Never replace this with `Promise.reject`.
 */
function rethrow(reason: unknown): void {
    rethrowing = true;
    setImmediate(() => {
        throw reason;
    });
}

/** Test-only: drop all listeners and module state. */
export function __resetForTests(): void {
    entries.clear();
    inFlight = [];
    uninstall();
    firing = false;
    rethrowing = false;
    generation++;
}
