/**
 * Fixture: an uncaught exception must still let a slow task finish, then crash
 * the way Node would have.
 */
import { registerExitTask } from "../shutdown-registry";

registerExitTask(async () => {
    await new Promise((r) => setTimeout(r, 250));
    console.log("SLOW_DONE");
});

console.log("READY");
setTimeout(() => {
    throw new Error("FIXTURE_BOOM");
}, 20);
