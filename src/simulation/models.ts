/**
 * Status indicating whether to continue or stop the conversation.
 */
export enum ConversationStatus {
  CONTINUE = "continue",
  STOP = "stop",
}

/**
 * Indicates who initiates the first message in a multi-turn conversation.
 *
 * - `"user"` — The simulated user (Netra BE) sends the first message.
 * - `"agent"` — The Agent Under Test generates the opening message.
 */
export type Initiator = "agent" | "user";

/**
 * Raw file metadata received from the backend.
 *
 * Contains a pre-signed download URL that the SDK uses to fetch the actual
 * file content. Instances are produced by parsing the `attachments` array
 * returned on each user message from the simulation API.
 */
export interface FileData {
  fileName: string;
  contentType: string;
  description?: string;
  downloadUrl: string;
}

/**
 * File after download and base64 encoding, delivered to the user task.
 *
 * The `data` field contains the raw file bytes encoded as a base64 ASCII
 * string.  Consumers should decode with `Buffer.from(data, "base64")` before
 * passing to an LLM or other downstream system.
 */
export interface ProcessedFile {
  fileName: string;
  contentType: string;
  description?: string;
  data: string;
}

/**
 * Represents a single item in a simulation run.
 *
 * When `message` is `null`, the Agent Under Test is expected to generate the
 * opening message (agent-initiated conversation).
 */
export interface SimulationItem {
  runItemId: string;
  message: string | null;
  turnId: string;
  files?: FileData[];
}

/**
 * Response from the conversation trigger API.
 */
export interface ConversationResponse {
  decision: string;
  reason?: string;
  nextTurnId?: string;
  nextUserMessage?: string;
  nextRunItemId?: string;
  nextFiles?: FileData[];
}

/**
 * Result returned from the user's task function.
 */
export interface TaskResult {
  message: string;
  sessionId: string;
}

/**
 * Result of a single conversation execution.
 */
export interface ConversationResult {
  runItemId: string;
  success: boolean;
  error?: string;
  finalTurnId?: string;
  turnId?: string;
}

/**
 * Overall simulation run result.
 */
export interface SimulationResult {
  success: boolean;
  completed: ConversationResult[];
  failed: ConversationResult[];
  totalItems: number;
}

