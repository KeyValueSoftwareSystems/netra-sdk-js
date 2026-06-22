import { Initiator, ProcessedFile, TaskResult } from "./models";


export abstract class BaseTask {
    /**
     * Process a simulation turn and return the agent's response.
     *
     * @param message - The input message from the simulation. Will be an empty
     *                  string when `initiator` is `"agent"` (the Agent Under
     *                  Test is expected to generate the opening message).
     * @param sessionId - The session identifier.
     * @param files - Optional list of base64-encoded file attachments from the
     *                dataset item.  Will be `null` when no files are attached.
     * @param initiator - Indicates who starts the conversation. `"user"`
     *                    (default) means the message originates from the
     *                    simulated user. `"agent"` means the Agent Under Test
     *                    should generate the opening message.
     * @returns The task result containing:
     *            - message (string): The response message from the task.
     *            - sessionId (string): The session identifier.
     */
    abstract run(
        message: string,
        sessionId?: string | null,
        files?: ProcessedFile[] | null,
        initiator?: Initiator,
    ): Promise<TaskResult> | TaskResult;
}
