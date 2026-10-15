/**
 * Fixture: a `signal-exit`-style listener (the pattern used by execa,
 * write-file-atomic, ink, ora and npm itself) re-raises a signal only when its
 * own listeners are the only ones attached.
 *
 * Our `appHandles` treats any non-SDK listener as "the application handles
 * this", so neither side re-raises and SIGTERM does not terminate the process.
 * Under Kubernetes the pod then waits out its grace period before SIGKILL.
 *
 * This fixture documents the interaction rather than asserting a fix: there is
 * no reliable way to recognise such a listener from the outside, and always
 * re-raising would run non-idempotent application handlers twice. Affected
 * apps should use `registerShutdownHooks: false`.
 */
import { registerExitTask } from "../shutdown-registry";

registerExitTask(async () => {
    console.log("FLUSHED");
});

const onSig = (sig: NodeJS.Signals) => {
    const others = process.listeners(sig).filter((l) => l !== onSig);
    if (others.length === 0) {
        process.removeListener(sig, onSig);
        process.kill(process.pid, sig);
    } else {
        console.log(`SIGNAL_EXIT_DEFERRED others=${others.length}`);
    }
};
process.on("SIGTERM", onSig);

setInterval(() => {}, 1000);
console.log("READY");
setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
setTimeout(() => {
    console.log("STILL_ALIVE_AFTER_SIGTERM");
    process.exit(99);
}, 1500);
