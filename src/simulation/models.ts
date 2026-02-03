/**
 * Status indicating whether to continue or stop the conversation.
 */
export enum ConversationStatus {
  CONTINUE = "continue",
  STOP = "stop",
}

/**
 * Represents a single item in a simulation run.
 */
export interface SimulationItem {
  runItemId: string;
  message: string;
  turnId: string;
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

/**
 * Type for user-provided task function.
 */
export type TaskFunction = (
  message: string,
  sessionId: string | null,
) => TaskResult | Promise<TaskResult>;
