/**
 * Fixture: an unhandled rejection must run the opted-in task and then be
 * restored to Node's default disposition (a real crash), not swallowed.
 */
import { registerExitTask } from "../shutdown-registry";

registerExitTask(
    async () => {
        await new Promise((r) => setTimeout(r, 200));
        console.log("TASK_DONE");
    },
    { unhandledRejection: true },
);

console.log("READY");
setTimeout(() => {
    void Promise.reject(new Error("FIXTURE_REJECTED"));
}, 20);
