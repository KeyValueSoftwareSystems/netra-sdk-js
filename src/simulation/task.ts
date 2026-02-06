import { TaskResult } from "./models";


export abstract class BaseTask {
    /**
     * @param message - The input message from the simulation.
     * @param sessionId - The Session identifier.
     * @returns The task result containing:
     *            - message (string): The response message from the task.
     *            - sessionId (string): The session identifier.
     */
    abstract run(
        message: string,
        sessionId?: string | null,
    ): Promise<TaskResult> | TaskResult;
}
