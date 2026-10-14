/**
 * Fixture: a fast task (span flush) and a slow one (run-status post) are both
 * registered when SIGTERM arrives. Both must finish before the process dies.
 * Run by shutdown-registry.integration.test.ts, not by the test runner.
 */
import { registerExitTask } from "../shutdown-registry";

registerExitTask(async () => {
    await new Promise((r) => setTimeout(r, 20));
    console.log("FAST_DONE");
});
registerExitTask(async () => {
    await new Promise((r) => setTimeout(r, 250));
    console.log("SLOW_DONE");
});

setInterval(() => {}, 1000);
console.log("READY");
setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
