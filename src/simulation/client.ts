import axios, { AxiosInstance, AxiosResponse, AxiosError } from "axios";
import { Config } from "../config";
import { Logger } from "../logger";
import { injectTraceContextHeaders } from "../utils/context-propagation";
import { ConversationResponse, SimulationItem } from "./models";
import { parseFiles } from "./utils";

const LOG_PREFIX = "netra.simulation";
const DEFAULT_TIMEOUT = 10000; // 10 seconds in milliseconds

/**
 * Result from initializing a simulation run (two-phase flow).
 */
export interface InitializeRunResult {
    runId: string;
    items: Array<{ runItemId: string; datasetItemId: string }>;
}

/**
 * Internal HTTP client for simulation API endpoints.
 */
export class SimulationHttpClient {
    private client: AxiosInstance | null = null;

    constructor(config: Config) {
        this.client = this._createClient(config);
    }

    /**
     * Create and configure the HTTP client.
     */
    private _createClient(config: Config): AxiosInstance | null {
        const endpoint = (config.otlpEndpoint || "").trim();
        if (!endpoint) {
            Logger.error(`${LOG_PREFIX}: NETRA_OTLP_ENDPOINT is required`);
            return null;
        }

        const baseURL = this._resolveBaseUrl(endpoint);
        const headers = this._buildHeaders(config);
        const timeout = this._getTimeout();

        try {
            const instance = axios.create({
                baseURL,
                headers,
                timeout,
            });

            // Inject W3C trace context (traceparent/tracestate) into every
            // outgoing request so the Netra backend can join the active trace.
            instance.interceptors.request.use(
                (config) => {
                    const traceHeaders = injectTraceContextHeaders({});
                    Object.assign(config.headers, traceHeaders);
                    return config;
                },
                (error) => Promise.reject(error),
            );

            return instance;
        } catch (error) {
            Logger.error(`${LOG_PREFIX}: Failed to create HTTP client:`, error);
            return null;
        }
    }

    /**
     * Extract base URL, removing telemetry suffix if present.
     */
    private _resolveBaseUrl(endpoint: string): string {
        let baseUrl = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
        if (baseUrl.endsWith("/telemetry")) {
            baseUrl = baseUrl.slice(0, -"/telemetry".length);
        }
        return baseUrl;
    }

    /**
     * Build request headers from configuration.
     */
    private _buildHeaders(config: Config): Record<string, string> {
        const headers: Record<string, string> = { ...config.headers };
        if (config.apiKey) {
            headers["x-api-key"] = config.apiKey;
        }
        return headers;
    }

    /**
     * Get timeout from environment or use default.
     */
    private _getTimeout(): number {
        const timeoutStr = process.env.NETRA_SIMULATION_TIMEOUT;
        if (!timeoutStr) {
            return DEFAULT_TIMEOUT;
        }

        const timeout = parseFloat(timeoutStr);
        if (isNaN(timeout)) {
            Logger.warn(
                `${LOG_PREFIX}: Invalid timeout '${timeoutStr}', using default ${DEFAULT_TIMEOUT}ms`,
            );
            return DEFAULT_TIMEOUT;
        }

        return timeout * 1000; // Convert seconds to milliseconds
    }

    /**
     * Initialize a simulation run without generating first user messages.
     *
     * Used in the two-phase flow so that beforeAll/before hooks can run
     * before any LLM spend.
     */
    async initializeRun(
        name: string,
        datasetId: string,
        context?: Record<string, any>,
        hooksMeta?: Record<string, any> | null,
    ): Promise<InitializeRunResult | null> {
        if (!this.client) {
            Logger.error(`${LOG_PREFIX}: Client not initialized`);
            return null;
        }

        try {
            const url = "/evaluations/test_run/multi-turn/initialize";
            const payload: Record<string, any> = {
                name,
                datasetId,
                context: context || {},
            };
            if (hooksMeta) {
                payload.lifecycleHooks = hooksMeta;
            }

            const response: AxiosResponse = await this.client.post(url, payload);
            const data = response.data;

            const responseData = data.data || {};
            const items = responseData.items || [];

            if (items.length === 0) {
                Logger.warn(`${LOG_PREFIX}: No items returned from initialize_run`);
                return null;
            }

            const runId = responseData.id || "";
            return {
                runId,
                items: items.map((item: any) => ({
                    runItemId: item.testRunItemId || "",
                    datasetItemId: item.datasetItemId || "",
                })),
            };
        } catch (error) {
            const errorMsg = this._extractErrorMessage(error);
            Logger.error(`${LOG_PREFIX}: Failed to initialize run:`, errorMsg);
            return null;
        }
    }

    /**
     * Generate the first user message for a single test run item.
     *
     * Used in the two-phase flow after hooks have been executed.
     */
    async generateFirstTurn(
        runId: string,
        runItemId: string,
    ): Promise<SimulationItem | null> {
        if (!this.client) {
            Logger.error(`${LOG_PREFIX}: Client not initialized`);
            return null;
        }

        try {
            const url = `/evaluations/run/${runId}/item/${runItemId}/first-turn`;
            const response: AxiosResponse = await this.client.post(url, {});
            const data = response.data;

            const responseData = data.data || {};
            return {
                runItemId,
                datasetItemId: responseData.datasetItemId || "",
                message: responseData.userMessage || "",
                turnId: responseData.turnId || "",
                files: parseFiles(responseData.attachments),
            };
        } catch (error) {
            const errorMsg = this._extractErrorMessage(error);
            Logger.error(
                `${LOG_PREFIX}: Failed to generate first turn for item ${runItemId}:`,
                errorMsg,
            );
            return null;
        }
    }

    /**
     * Send a conversation turn to the backend and get the next response.
     */
    async triggerConversation(
        message: string,
        turnId: string,
        sessionId: string,
        traceId: string,
    ): Promise<ConversationResponse | null> {
        if (!this.client) {
            Logger.error(`${LOG_PREFIX}: Client not initialized`);
            return null;
        }

        try {
            const url = "/evaluations/turn/agent-response";
            const payload = {
                turnId,
                agentResponse: { message },
                sessionId,
                traceId,
            };

            const response: AxiosResponse = await this.client.post(url, payload);
            const data = response.data;

            const responseData = data.data || {};
            const decision = responseData.decision || "continue";

            if (decision === "stop") {
                return {
                    decision,
                    reason: responseData.reason || "",
                };
            }

            const userMessages = responseData.userMessages || [];
            if (userMessages.length === 0) {
                Logger.warn(`${LOG_PREFIX}: No user messages in continue response`);
                return null;
            }

            const nextMsg = userMessages[0];
            return {
                decision,
                nextTurnId: nextMsg.turnId || "",
                nextUserMessage: nextMsg.userMessage || "",
                nextRunItemId: nextMsg.testRunItemId || "",
                nextFiles: parseFiles(nextMsg.attachments),
            };
        } catch (error) {
            const errorMsg = this._extractErrorMessage(error);
            Logger.error(`${LOG_PREFIX}: Failed to trigger conversation:`, errorMsg);
            return null;
        }
    }

    /**
     * Report a task execution failure to the backend.
     */
    async reportFailure(
        runId: string,
        runItemId: string,
        error: string,
        status: string = "failed",
    ): Promise<void> {
        if (!this.client) {
            Logger.error(`${LOG_PREFIX}: Client not initialized`);
            return;
        }

        try {
            const url = `/evaluations/run/${runId}/item/${runItemId}/status`;
            const payload = { status, failureReason: error };
            await this.client.patch(url, payload);
            Logger.info(`${LOG_PREFIX}: Reported failure - ${error}`);
        } catch (err) {
            const errorMsg = this._extractErrorMessage(err);
            Logger.error(`${LOG_PREFIX}: Failed to report failure:`, errorMsg);
        }
    }

    /**
     * Submit the run status.
     */
    async postRunStatus(runId: string, status: string): Promise<any> {
        if (!this.client) {
            Logger.error(
                `${LOG_PREFIX}: Client not initialized; cannot post run status`,
            );
            return { success: false };
        }

        try {
            const url = `/evaluations/run/${runId}/status`;
            const payload = { status };
            const response: AxiosResponse = await this.client.post(url, payload);
            const data = response.data;

            if (data && typeof data === "object" && "data" in data) {
                Logger.info(`${LOG_PREFIX}: Completed test run successfully`);
                return data.data || {};
            }
            return data;
        } catch (error) {
            const errorMsg = this._extractErrorMessage(error);
            Logger.error(
                `${LOG_PREFIX}: Failed to post run status for run '${runId}':`,
                errorMsg,
            );
            return { success: false };
        }
    }

    /**
     * Extract error message from response or exception.
     */
    private _extractErrorMessage(error: any): string {
        if (axios.isAxiosError(error)) {
            const axiosError = error as AxiosError;
            if (axiosError.response?.data) {
                const responseData = axiosError.response.data as any;
                if (
                    typeof responseData === "object" &&
                    responseData.error &&
                    typeof responseData.error === "object"
                ) {
                    return responseData.error.message || error.message;
                }
            }
            return axiosError.message;
        }
        return error?.message || String(error);
    }
}
