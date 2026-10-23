/**
 * Real-process tests for the shutdown registry.
 *
 * These spawn actual child processes and send actual signals, because the
 * synthetic `process.emit` style used elsewhere cannot model the thing that
 * broke: Node exiting the moment a handler returns. Every case here fails
 * against the pre-coordinator implementation.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, afterAll, describe, expect, it } from "vitest";

const ESBUILD = join(process.cwd(), "node_modules", ".bin", "esbuild");
let outDir: string;

/**
 * Bundle a fixture to plain JS so plain `node` can run it. ts-node's ESM loader
 * is broken on Node 23 and Node's native type stripping cannot resolve this
 * repo's extensionless imports, so bundling is the one path that works.
 */
function bundle(name: string): string {
    const outfile = join(outDir, `${name}.mjs`);
    execFileSync(ESBUILD, [
        join(process.cwd(), "src", "__fixtures__", `${name}.ts`),
        "--bundle",
        "--format=esm",
        "--platform=node",
        `--outfile=${outfile}`,
        "--log-level=error",
    ]);
    return outfile;
}

interface RunResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    ms: number;
}

function run(file: string): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const child = spawn(process.execPath, [file], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code, signal) =>
            resolve({ code, signal, stdout, stderr, ms: Date.now() - started }),
        );
    });
}

beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "netra-shutdown-"));
});

afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
});

describe("shutdown registry (real process)", () => {
    it("finishes every task before the signal kills the process", async () => {
        const result = await run(bundle("exit-signal"));

        // The original bug: the fast task re-raised while the slow one was
        // still mid-request, so SLOW_DONE never printed.
        expect(result.stdout).toContain("FAST_DONE");
        expect(result.stdout).toContain("SLOW_DONE");
        // And the process still dies the conventional way, not with code 0.
        expect(result.signal ?? result.code).toBe(
            result.signal ? "SIGTERM" : 143,
        );
    }, 20_000);

    it("finishes every task on a crash, then crashes the way Node would", async () => {
        const result = await run(bundle("exit-crash"));

        // uncaughtExceptionMonitor could not keep the process alive for this.
        expect(result.stdout).toContain("SLOW_DONE");
        expect(result.code).toBe(1);
        // The original error still reaches stderr rather than being swallowed.
        expect(result.stderr).toContain("FIXTURE_BOOM");
    }, 20_000);

    it("leaves the exit code to an application that handles the signal", async () => {
        const result = await run(bundle("exit-app-handler"));

        expect(result.stdout).toContain("TASK_DONE");
        expect(result.stdout).toContain("APP_EXIT");
        expect(result.code).toBe(0);
        expect(result.signal).toBeNull();
    }, 20_000);

    it("restores Node's default crash for an unhandled rejection", async () => {
        const result = await run(bundle("exit-rejection"));

        expect(result.stdout).toContain("TASK_DONE");
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("FIXTURE_REJECTED");
    }, 20_000);

    it("does not let the app exit before a sibling exit task finishes", async () => {
        // The regression test for the failure observed end-to-end: the app's
        // own `await shutdown(); process.exit(0)` resolved while the run-status
        // post was still in flight, leaving the run stuck as "running".
        const result = await run(bundle("exit-app-awaits-shutdown"));

        expect(result.stdout).toContain("FLUSH_DONE");
        expect(result.stdout).toContain("RUN_STATUS_POSTED");
        expect(result.code).toBe(0);

        // Ordering is the actual property: the post must land before the exit.
        const posted = result.stdout.indexOf("RUN_STATUS_POSTED");
        const exited = result.stdout.indexOf("APP_EXIT");
        expect(posted).toBeGreaterThan(-1);
        expect(exited).toBeGreaterThan(posted);
    }, 20_000);

    it("documents the deadlock with signal-exit-style listeners", async () => {
        // KNOWN LIMITATION, pre-dating the coordinator (the same listenerCount
        // guard shipped in 26cec5c). `signal-exit` re-raises only when its own
        // listeners are alone; we defer to any non-SDK listener. So neither
        // re-raises and the process outlives SIGTERM -- under Kubernetes it is
        // SIGKILLed at the end of the grace period instead.
        //
        // This asserts the CURRENT behaviour so the day it changes is visible.
        // Affected apps should pass `registerShutdownHooks: false`.
        const result = await run(bundle("exit-signal-exit-style"));

        expect(result.stdout).toContain("FLUSHED");
        expect(result.stdout).toContain("SIGNAL_EXIT_DEFERRED");
        expect(result.stdout).toContain("STILL_ALIVE_AFTER_SIGTERM");
        expect(result.code).toBe(99); // the fixture's own escape hatch
    }, 20_000);

    it("exits promptly on a second signal instead of waiting out the budget", async () => {
        const result = await run(bundle("exit-double-signal"));

        expect(result.stdout).not.toContain("SHOULD_NOT_PRINT");
        expect(result.signal ?? result.code).toBe(
            result.signal ? "SIGTERM" : 143,
        );
        // The task asks for 30s; escalation must not wait for it.
        expect(result.ms).toBeLessThan(5_000);
    }, 20_000);

    it("dies by the signal when the app removes its handler and re-sends it", async () => {
        const result = await run(bundle("exit-app-resends-signal"));

        expect(result.stdout).not.toContain("STILL_ALIVE_AFTER_SIGTERM");
        expect(result.signal ?? result.code).toBe(
            result.signal ? "SIGTERM" : 143,
        );
    }, 20_000);
});
