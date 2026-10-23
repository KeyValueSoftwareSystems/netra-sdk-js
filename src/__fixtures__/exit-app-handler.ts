/**
 * Fixture: the application handles SIGTERM itself. The SDK must flush and then
 * stay out of the way, leaving the exit code to the app.
 */
import { registerExitTask } from "../shutdown-registry";

registerExitTask(async () => {
    await new Promise((r) => setTimeout(r, 20));
    console.log("TASK_DONE");
});

process.on("SIGTERM", () => {
    setTimeout(() => {
        console.log("APP_EXIT");
        process.exit(0);
    }, 200);
});

setInterval(() => {}, 1000);
console.log("READY");
setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
