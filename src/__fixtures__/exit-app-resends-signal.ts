/**
 * Fixture: a NestJS-style handler registered before the SDK removes itself,
 * cleans up, then re-sends the signal to hand the exit back to Node. The
 * re-sent signal lands while our task is still running. That is a hand-back,
 * not a second "I meant it" signal: the task must finish, and the process must
 * then die by the signal rather than hang until SIGKILL.
 */
import { registerExitTask } from "../shutdown-registry";

const appHandler = (sig: NodeJS.Signals) => {
    process.removeListener(sig, appHandler);
    setTimeout(() => process.kill(process.pid, sig), 100);
};
process.on("SIGTERM", appHandler);

registerExitTask(async () => {
    await new Promise((r) => setTimeout(r, 1000));
    console.log("FLUSHED");
});

setInterval(() => {}, 1000);
console.log("READY");
setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
setTimeout(() => {
    console.log("STILL_ALIVE_AFTER_SIGTERM");
    process.exit(99);
}, 4000);
