/**
 * Fixture: the common application shutdown pattern —
 *
 *   process.on("SIGTERM", async () => { await Netra.shutdown(); process.exit(0); });
 *
 * `shutdown()` must not resolve while a sibling exit task (here, a slow
 * run-status post) is still in flight, or the application's `process.exit(0)`
 * truncates it. This is the case that was observed failing against a real
 * backend: the interrupted run stayed "running".
 */
import { registerExitTask, settleOtherExitTasks } from "../shutdown-registry";

// Stands in for Netra.shutdown(): flush, then drain the other exit tasks.
const shutdown = async () => {
    await new Promise((r) => setTimeout(r, 20));
    console.log("FLUSH_DONE");
    await settleOtherExitTasks(flushTask);
};
const flushTask = () => shutdown();

registerExitTask(flushTask);

// The slow sibling, e.g. postRunStatus(runId, "failed").
registerExitTask(async () => {
    await new Promise((r) => setTimeout(r, 250));
    console.log("RUN_STATUS_POSTED");
});

// The application's own handler, exactly as apps are told to write it.
process.on("SIGTERM", async () => {
    await shutdown();
    console.log("APP_EXIT");
    process.exit(0);
});

setInterval(() => {}, 1000);
console.log("READY");
setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
