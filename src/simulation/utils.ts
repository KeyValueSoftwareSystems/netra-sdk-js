import axios from "axios";
import pLimit from "p-limit";
import { Logger } from "../logger";
import { FileData, ProcessedFile } from "./models";
import { BaseTask } from "./task";

const LOG_PREFIX = "netra.simulation";
const DEFAULT_FILE_DOWNLOAD_TIMEOUT_S = 30;
const MAX_FILE_DOWNLOAD_WORKERS = 8;

/**
 * Format the trace ID as a 32-digit hexadecimal string.
 *
 * @param traceId - The integer trace ID to format
 * @returns The formatted trace ID as a hexadecimal string
 */
export function formatTraceId(traceId: number): string {
    return traceId.toString(16).padStart(32, "0");
}

/**
 * Validate required inputs for simulation.
 *
 * @param datasetId - The dataset identifier to validate
 * @param task - The task function to validate
 * @returns True if inputs are valid, false otherwise
 */
export function validateSimulationInputs(
    datasetId: string,
    task: BaseTask,
): boolean {
    if (!datasetId) {
        Logger.error(`${LOG_PREFIX}: dataset_id is required`);
        return false;
    }
    if (!(task instanceof BaseTask)) {
        Logger.error(`${LOG_PREFIX}: task must be a BaseTask instance`);
        return false;
    }
    return true;
}

/**
 * Get the file download timeout in milliseconds.
 *
 * Reads from the `NETRA_SIMULATION_FILE_DOWNLOAD_TIMEOUT` environment
 * variable (value in seconds).  Falls back to the default of 30 s.
 *
 * @returns Timeout in milliseconds
 */
function _getFileDownloadTimeout(): number {
    const envVal = process.env.NETRA_SIMULATION_FILE_DOWNLOAD_TIMEOUT;
    if (envVal) {
        const parsed = parseFloat(envVal);
        if (!isNaN(parsed) && parsed > 0) {
            return parsed * 1000;
        }
        Logger.warn(
            `${LOG_PREFIX}: Invalid file download timeout '${envVal}', using default ${DEFAULT_FILE_DOWNLOAD_TIMEOUT_S}s`,
        );
    }
    return DEFAULT_FILE_DOWNLOAD_TIMEOUT_S * 1000;
}

/**
 * Download a single file from its pre-signed URL and base64-encode the content.
 *
 * @param fileData - Metadata with the download URL
 * @param timeoutMs - Request timeout in milliseconds
 * @returns ProcessedFile with base64-encoded data
 * @throws Error if the download fails
 */
async function _downloadSingleFile(
    fileData: FileData,
    timeoutMs: number,
): Promise<ProcessedFile> {
    const response = await axios.get(fileData.downloadUrl, {
        responseType: "arraybuffer",
        timeout: timeoutMs,
    });

    const encoded = Buffer.from(response.data).toString("base64");
    return {
        fileName: fileData.fileName,
        contentType: fileData.contentType,
        description: fileData.description,
        data: encoded,
    };
}

/**
 * Download and base64-encode a batch of files concurrently.
 *
 * Uses up to {@link MAX_FILE_DOWNLOAD_WORKERS} parallel downloads.  If any
 * single download fails the entire batch is considered failed and the error
 * propagates to the caller.
 *
 * @param files - Array of FileData objects to download
 * @returns Array of ProcessedFile objects with base64-encoded data, or null
 *          when the input array is empty / undefined
 * @throws Error if any file download fails
 */
export async function processFiles(
    files: FileData[] | null | undefined,
): Promise<ProcessedFile[] | null> {
    if (!files || files.length === 0) {
        return null;
    }

    const timeoutMs = _getFileDownloadTimeout();
    const limit = pLimit(MAX_FILE_DOWNLOAD_WORKERS);

    const downloadPromises = files.map((file) =>
        limit(() => _downloadSingleFile(file, timeoutMs)),
    );

    return Promise.all(downloadPromises);
}

/**
 * Execute a task function (sync or async) and extract message and session_id.
 *
 * When `rawFiles` is provided, the files are downloaded and base64-encoded
 * before being passed to the task's `run` method.
 *
 * @param task - The task function to execute
 * @param message - The input message to pass to the task
 * @param sessionId - The current session identifier
 * @param rawFiles - Optional array of file metadata to download and forward
 * @returns A tuple of [response_message, session_id]
 * @throws Error if the task returns an unsupported type or file download fails
 */
export async function executeTask(
    task: BaseTask,
    message: string,
    sessionId: string | null,
    rawFiles?: FileData[] | null,
): Promise<[string, string | null]> {
    const processedFiles = rawFiles && rawFiles.length > 0
        ? await processFiles(rawFiles)
        : null;

    const result = task.run(message, sessionId, processedFiles);

    const resolvedResult = result instanceof Promise ? await result : result;

    if (
        typeof resolvedResult === "object" &&
        resolvedResult !== null &&
        "message" in resolvedResult &&
        "sessionId" in resolvedResult
    ) {
        return [resolvedResult.message, resolvedResult.sessionId];
    }

    throw new Error(
        `Task must return TaskResult, got ${typeof resolvedResult}`,
    );
}
