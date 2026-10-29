/**
 * Fixture: a SIGTERM listener that is present when the SDK installs but is
 * removed before any signal arrives (e.g. a transient `signal-exit` hook from
 * write-file-atomic). With nothing handling SIGTERM any more, the SDK must
 * re-raise it instead of trusting its install-time snapshot.
 */
import { registerExitTask } from "../shutdown-registry";

const transient = () => {};
process.on("SIGTERM", transient);

registerExitTask(async () => {
    console.log("FLUSHED");
});

process.removeListener("SIGTERM", transient);

setInterval(() => {}, 1000);
console.log("READY");
setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
setTimeout(() => {
    console.log("STILL_ALIVE_AFTER_SIGTERM");
    process.exit(99);
}, 1500);
