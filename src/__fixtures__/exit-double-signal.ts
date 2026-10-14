/**
 * Fixture: a second SIGTERM during shutdown means "I meant it" — the process
 * must exit promptly rather than waiting out the task budget.
 */
import { registerExitTask } from "../shutdown-registry";

registerExitTask(async () => {
    await new Promise((r) => setTimeout(r, 30_000));
    console.log("SHOULD_NOT_PRINT");
});

setInterval(() => {}, 1000);
console.log("READY");
setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
setTimeout(() => process.kill(process.pid, "SIGTERM"), 200);
