import { afterEach, describe, expect, it, vi } from "vitest";

import {
    EXIT_BUDGET_MS,
    FLUSH_TIMEOUT_MS,
    __resetForTests,
    registerExitTask,
} from "./shutdown-registry";

const EVENTS = [
    "SIGINT",
    "SIGTERM",
    "uncaughtException",
    "unhandledRejection",
] as const;
const counts = () => EVENTS.map((e) => process.listenerCount(e));

/** Let the handler's promise chain settle. */
const settle = async (ticks = 6) => {
    for (let i = 0; i < ticks; i++) {
        await new Promise((r) => setImmediate(r));
    }
};

afterEach(() => {
    __resetForTests();
    vi.restoreAllMocks();
});

describe("shutdown registry: listener ownership", () => {
    it("installs listeners on first registration and removes them on the last unregister", () => {
        const before = counts();

        const unregisterA = registerExitTask(async () => {});
        // SIGINT, SIGTERM and uncaughtException only: unhandledRejection is
        // opt-in and nobody asked for it.
        expect(counts()).toEqual([
            before[0] + 1,
            before[1] + 1,
            before[2] + 1,
            before[3],
        ]);

        const unregisterB = registerExitTask(async () => {});
        expect(counts()).toEqual([
            before[0] + 1,
            before[1] + 1,
            before[2] + 1,
            before[3],
        ]);

        unregisterA();
        expect(counts()).not.toEqual(before);
        unregisterB();
        expect(counts()).toEqual(before);
    });

    it("does not arm unhandledRejection unless a task opts in", () => {
        const before = process.listenerCount("unhandledRejection");

        const unregisterPlain = registerExitTask(async () => {});
        expect(process.listenerCount("unhandledRejection")).toBe(before);

        const unregisterOptedIn = registerExitTask(async () => {}, {
            unhandledRejection: true,
        });
        expect(process.listenerCount("unhandledRejection")).toBe(before + 1);

        // Dropping the opted-in task disarms the event again, even though
        // another task is still registered.
        unregisterOptedIn();
        expect(process.listenerCount("unhandledRejection")).toBe(before);

        unregisterPlain();
        expect(process.listenerCount("unhandledRejection")).toBe(before);
    });
});

describe("shutdown registry: signal handling", () => {
    it("waits for every task before re-raising the signal", async () => {
        // The regression test for the original bug: a fast task (span flush)
        // must not re-raise while a slow one (run-status post) is mid-request.
        const order: string[] = [];
        const kill = vi
            .spyOn(process, "kill")
            .mockImplementation((() => {
                order.push("kill");
                return true;
            }) as never);

        registerExitTask(async () => {
            await new Promise((r) => setTimeout(r, 5));
            order.push("fast");
        });
        registerExitTask(async () => {
            await new Promise((r) => setTimeout(r, 40));
            order.push("slow");
        });

        process.emit("SIGTERM", "SIGTERM");
        await vi.waitFor(() => expect(kill).toHaveBeenCalled());

        expect(order).toEqual(["fast", "slow", "kill"]);
    });

    it("flushes without re-raising when the application handles the signal", async () => {
        const kill = vi
            .spyOn(process, "kill")
            .mockImplementation((() => true) as never);
        const appHandler = vi.fn();
        process.on("SIGTERM", appHandler);

        try {
            const task = vi.fn().mockResolvedValue(undefined);
            registerExitTask(task);

            process.emit("SIGTERM", "SIGTERM");
            await vi.waitFor(() => expect(task).toHaveBeenCalled());
            await settle();

            expect(appHandler).toHaveBeenCalled();
            expect(kill).not.toHaveBeenCalled();
        } finally {
            process.removeListener("SIGTERM", appHandler);
        }
    });

    it("does not re-raise when the app registered its handler before init", async () => {
        // An app using process.once has its listener removed by Node before any
        // handler runs, so it is invisible by the time we decide. We remember
        // that it was there when we installed.
        const kill = vi
            .spyOn(process, "kill")
            .mockImplementation((() => true) as never);
        const appHandler = vi.fn();
        process.once("SIGTERM", appHandler);

        try {
            const task = vi.fn().mockResolvedValue(undefined);
            registerExitTask(task);

            process.emit("SIGTERM", "SIGTERM");
            await vi.waitFor(() => expect(task).toHaveBeenCalled());
            await settle();

            expect(kill).not.toHaveBeenCalled();
        } finally {
            process.removeListener("SIGTERM", appHandler);
        }
    });

    it("re-raises when the app removed its pre-init handler before the signal", async () => {
        // The install-time snapshot must not outlive the listener it recorded,
        // or nothing re-raises and the process hangs until SIGKILL.
        const kill = vi
            .spyOn(process, "kill")
            .mockImplementation((() => true) as never);
        const appHandler = vi.fn();
        process.on("SIGTERM", appHandler);

        try {
            const task = vi.fn().mockResolvedValue(undefined);
            registerExitTask(task);
            process.removeListener("SIGTERM", appHandler);
            await settle(1);

            process.emit("SIGTERM", "SIGTERM");
            await vi.waitFor(() =>
                expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM"),
            );
            expect(appHandler).not.toHaveBeenCalled();
        } finally {
            process.removeListener("SIGTERM", appHandler);
        }
    });

    it("exits immediately on a second signal instead of waiting out the budget", async () => {
        const kill = vi
            .spyOn(process, "kill")
            .mockImplementation((() => true) as never);

        let released!: () => void;
        registerExitTask(
            () => new Promise<void>((r) => { released = r; }),
        );

        process.emit("SIGTERM", "SIGTERM");
        await settle();
        expect(kill).not.toHaveBeenCalled(); // still flushing

        process.emit("SIGTERM", "SIGTERM");
        await settle();

        // Escalated without the slow task ever finishing.
        expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
        expect(process.listenerCount("SIGTERM")).toBe(0);
        released();
    });

    it("finishes the tasks when the app hands a re-sent signal back", async () => {
        // NestJS enableShutdownHooks(): the app handles the first signal,
        // removes its handler, cleans up and re-sends the signal. That is a
        // hand-back, not "I meant it", so the flush must not be abandoned.
        const kill = vi
            .spyOn(process, "kill")
            .mockImplementation((() => true) as never);
        const appHandler = (sig: NodeJS.Signals) => {
            process.removeListener(sig, appHandler);
            process.emit("SIGTERM", "SIGTERM");
        };
        process.on("SIGTERM", appHandler);

        try {
            let released!: () => void;
            const done = vi.fn();
            registerExitTask(
                () => new Promise<void>((r) => { released = r; }).then(done),
            );

            process.emit("SIGTERM", "SIGTERM");
            await settle();
            expect(kill).not.toHaveBeenCalled(); // still flushing

            released();
            await vi.waitFor(() =>
                expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM"),
            );
            expect(done).toHaveBeenCalled();
            expect(kill).toHaveBeenCalledTimes(1);
        } finally {
            process.removeListener("SIGTERM", appHandler);
        }
    });

    it("does not mistake a different signal for a hand-back", async () => {
        // The app owns SIGTERM but not SIGINT: Ctrl+C during the flush is the
        // user insisting, not the app handing SIGTERM back.
        const kill = vi
            .spyOn(process, "kill")
            .mockImplementation((() => true) as never);
        const appHandler = vi.fn();
        process.on("SIGTERM", appHandler);

        try {
            registerExitTask(() => new Promise<void>(() => {}));

            process.emit("SIGTERM", "SIGTERM");
            await settle();
            process.emit("SIGINT", "SIGINT");
            await settle();

            expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT");
            expect(process.listenerCount("SIGINT")).toBe(0);
        } finally {
            process.removeListener("SIGTERM", appHandler);
        }
    });

    it("still exits immediately on a signal after a hand-back", async () => {
        const kill = vi
            .spyOn(process, "kill")
            .mockImplementation((() => true) as never);
        const appHandler = (sig: NodeJS.Signals) => {
            process.removeListener(sig, appHandler);
            process.emit("SIGTERM", "SIGTERM");
        };
        process.on("SIGTERM", appHandler);

        try {
            let released!: () => void;
            registerExitTask(
                () => new Promise<void>((r) => { released = r; }),
            );

            process.emit("SIGTERM", "SIGTERM"); // app handles, then hands back
            await settle();
            expect(kill).not.toHaveBeenCalled();

            process.emit("SIGTERM", "SIGTERM"); // the user insists
            await settle();
            expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
            expect(process.listenerCount("SIGTERM")).toBe(0);

            released();
            await settle();
            expect(kill).toHaveBeenCalledTimes(1); // abandoned fire stays quiet
        } finally {
            process.removeListener("SIGTERM", appHandler);
        }
    });

    it("abandons a task that outlives the exit budget", async () => {
        vi.useFakeTimers();
        try {
            const kill = vi
                .spyOn(process, "kill")
                .mockImplementation((() => true) as never);

            registerExitTask(() => new Promise<void>(() => {})); // never settles

            process.emit("SIGTERM", "SIGTERM");
            await vi.advanceTimersByTimeAsync(EXIT_BUDGET_MS + 10);

            expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
        } finally {
            vi.useRealTimers();
        }
    });

    it("gives tasks a budget that outlasts the inner flush timeout", async () => {
        // The outer budget must strictly dominate FLUSH_TIMEOUT_MS, or it would
        // truncate the very flush it exists to protect.
        expect(EXIT_BUDGET_MS).toBeGreaterThan(FLUSH_TIMEOUT_MS);

        vi.useFakeTimers();
        try {
            const kill = vi
                .spyOn(process, "kill")
                .mockImplementation((() => true) as never);
            const done = vi.fn();

            registerExitTask(async () => {
                await new Promise((r) => setTimeout(r, FLUSH_TIMEOUT_MS + 500));
                done();
            });

            process.emit("SIGTERM", "SIGTERM");
            await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS + 600);

            expect(done).toHaveBeenCalled();
            expect(kill).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("shutdown registry: re-entrancy", () => {
    it("keeps listeners attached while a task unregisters itself mid-shutdown", async () => {
        // Netra.shutdown() calls _removeShutdownHooks(), so the flush task
        // unregisters itself while the run-status task is still in flight.
        // Tearing the listeners down then would leave that task unprotected.
        vi.spyOn(process, "kill").mockImplementation((() => true) as never);

        let attachedDuringSlowTask = -1;
        let unregisterSelf!: () => void;
        unregisterSelf = registerExitTask(async () => {
            unregisterSelf();
        });
        const slow = vi.fn(async () => {
            await new Promise((r) => setTimeout(r, 20));
            attachedDuringSlowTask = process.listenerCount("uncaughtException");
        });
        registerExitTask(slow);

        process.emit("SIGTERM", "SIGTERM");
        await vi.waitFor(() => expect(slow).toHaveBeenCalled());
        await settle();

        expect(attachedDuringSlowTask).toBeGreaterThan(0);
    });

    it("does not swallow a crash during shutdown when nothing else handles it", async () => {
        // Our listener is still attached while tasks run, so Node will not act
        // on the error. If we simply ignored it, it would be neither logged nor
        // fatal and the process would limp on in a broken state.
        vi.spyOn(process, "kill").mockImplementation((() => true) as never);
        const exit = vi
            .spyOn(process, "exit")
            .mockImplementation((() => undefined) as never);
        const errorLog = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        // The test runner installs its own uncaughtException listener; detach
        // it so this exercises the nobody-is-handling-this path.
        const others = process.listeners("uncaughtException");
        others.forEach((l) => process.removeListener("uncaughtException", l));

        try {
            registerExitTask(() => new Promise((r) => setTimeout(r, 50)));

            process.emit("SIGTERM", "SIGTERM");
            await settle();

            const crash = new Error("crash during shutdown");
            process.emit("uncaughtException", crash);
            await settle();

            expect(errorLog).toHaveBeenCalledWith(crash);
            expect(exit).toHaveBeenCalledWith(1);
        } finally {
            others.forEach((l) =>
                process.on("uncaughtException", l as (e: Error) => void),
            );
        }
    });

    it("leaves a crash during shutdown to the app when the app handles it", async () => {
        // An application draining connections in its own SIGTERM handler may
        // also handle stray errors. Forcing an exit here would kill it
        // mid-cleanup and report a crash, contradicting the promise in
        // config.ts that the SDK never exits while the app has its own
        // handlers.
        vi.spyOn(process, "kill").mockImplementation((() => true) as never);
        const exit = vi
            .spyOn(process, "exit")
            .mockImplementation((() => undefined) as never);
        const appHandler = vi.fn();
        process.on("uncaughtException", appHandler);

        try {
            registerExitTask(() => new Promise((r) => setTimeout(r, 50)));

            process.emit("SIGTERM", "SIGTERM");
            await settle();

            process.emit("uncaughtException", new Error("stray error"));
            await settle();

            expect(appHandler).toHaveBeenCalled();
            expect(exit).not.toHaveBeenCalled();
        } finally {
            process.removeListener("uncaughtException", appHandler);
        }
    });

    it("stays out of a rejection the app handles, and stays armed", async () => {
        // The app owns the event, so nothing is shutting down. Firing here
        // would burn the one-shot exit tasks: observed live, a recovered
        // rejection marked a healthy simulation run "failed" before the run
        // went on to complete.
        vi.spyOn(process, "kill").mockImplementation((() => true) as never);
        const flush = vi.fn().mockResolvedValue(undefined);
        const optedIn = vi.fn().mockResolvedValue(undefined);
        registerExitTask(flush);
        registerExitTask(optedIn, { unhandledRejection: true });

        const appRejectionHandler = vi.fn();
        process.on("unhandledRejection", appRejectionHandler);

        try {
            const armed = process.listenerCount("SIGTERM");
            process.emit(
                "unhandledRejection",
                new Error("recovered"),
                Promise.resolve(),
            );
            await settle();

            // Nothing consumed, nothing torn down.
            expect(optedIn).not.toHaveBeenCalled();
            expect(flush).not.toHaveBeenCalled();
            expect(process.listenerCount("SIGTERM")).toBe(armed);

            // Both still run when the process really does go away.
            process.emit("SIGTERM", "SIGTERM");
            await vi.waitFor(() => expect(flush).toHaveBeenCalled());
            expect(optedIn).toHaveBeenCalled();
        } finally {
            process.removeListener("unhandledRejection", appRejectionHandler);
        }
    });
});

describe("shutdown registry: crash handling", () => {
    it("runs tasks then mirrors Node's default exit", async () => {
        const exit = vi
            .spyOn(process, "exit")
            .mockImplementation((() => undefined) as never);
        const errorLog = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        // The test runner installs its own uncaughtException listener, which
        // the registry correctly treats as "the application handles this".
        // Detach it so this test exercises the no-app-handler path.
        const others = process.listeners("uncaughtException");
        others.forEach((l) => process.removeListener("uncaughtException", l));

        try {
            const task = vi.fn().mockResolvedValue(undefined);
            registerExitTask(task);

            const crash = new Error("boom");
            process.emit("uncaughtException", crash);
            await vi.waitFor(() => expect(task).toHaveBeenCalled());
            await settle();

            expect(task).toHaveBeenCalledWith({
                kind: "uncaughtException",
                error: crash,
            });
            expect(errorLog).toHaveBeenCalledWith(crash);
            expect(exit).toHaveBeenCalledWith(1);
        } finally {
            others.forEach((l) =>
                process.on("uncaughtException", l as (e: Error) => void),
            );
        }
    });

    it("stays out of a crash the application handles, and stays armed", async () => {
        // The application owns the event and may carry on running, so the
        // process is not necessarily going away. Firing here would burn the
        // one-shot exit tasks and tear down our listeners, leaving the SDK
        // disarmed for the SIGTERM that really does end the process.
        // Observed live: listener counts dropped 2 -> 1 after a recovered
        // crash in the loan-agent harness.
        vi.spyOn(process, "kill").mockImplementation((() => true) as never);
        const exit = vi
            .spyOn(process, "exit")
            .mockImplementation((() => undefined) as never);
        const appHandler = vi.fn();
        process.on("uncaughtException", appHandler);

        try {
            const task = vi.fn().mockResolvedValue(undefined);
            registerExitTask(task);
            const armed = process.listenerCount("SIGTERM");

            process.emit("uncaughtException", new Error("boom"));
            await settle();

            expect(appHandler).toHaveBeenCalled();
            expect(exit).not.toHaveBeenCalled();
            // Nothing consumed, nothing torn down.
            expect(task).not.toHaveBeenCalled();
            expect(process.listenerCount("SIGTERM")).toBe(armed);

            // And the task still runs when the process really does go away.
            process.emit("SIGTERM", "SIGTERM");
            await vi.waitFor(() => expect(task).toHaveBeenCalled());
        } finally {
            process.removeListener("uncaughtException", appHandler);
        }
    });

    it("opting in arms the listener; it does not fire on a survivable rejection", async () => {
        // `unhandledRejection: true` governs whether the SDK listens at all.
        // A fatal rejection (nothing handles it) then runs every task and
        // restores Node's crash -- covered by the child-process tests, where
        // a real crash is the expected outcome.
        const appHandler = vi.fn();
        process.on("unhandledRejection", appHandler);

        try {
            const plain = vi.fn().mockResolvedValue(undefined);
            const optedIn = vi.fn().mockResolvedValue(undefined);
            registerExitTask(plain);
            registerExitTask(optedIn, { unhandledRejection: true });

            expect(process.listenerCount("unhandledRejection")).toBeGreaterThan(
                1,
            );

            process.emit(
                "unhandledRejection",
                new Error("nope"),
                Promise.resolve(),
            );
            await settle();

            expect(appHandler).toHaveBeenCalled();
            expect(plain).not.toHaveBeenCalled();
            expect(optedIn).not.toHaveBeenCalled();
        } finally {
            process.removeListener("unhandledRejection", appHandler);
        }
    });
});
