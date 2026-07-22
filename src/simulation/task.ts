import { ProcessedFile, TaskResult } from "./models";


export abstract class BaseTask {
    /**
     * Process a simulation turn and return the agent's response.
     *
     * @param message - The input message from the simulation.
     * @param sessionId - The session identifier.
     * @param files - Optional list of base64-encoded file attachments from the
     *                dataset item.  Will be `null` when no files are attached.
     * @param setupContext - Optional dict populated by `beforeAll` and `before`
     *                       hooks. Will be `null` when no hooks are configured.
     *                       Use this to access shared resources (e.g. a pre-created
     *                       employee ID) set up before the scenario started.
     * @returns The task result containing:
     *            - message (string): The response message from the task.
     *            - sessionId (string): The session identifier.
     */
    abstract run(
        message: string,
        sessionId?: string | null,
        files?: ProcessedFile[] | null,
        setupContext?: Record<string, any> | null,
    ): Promise<TaskResult> | TaskResult;
}
