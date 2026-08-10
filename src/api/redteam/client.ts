import axios, { AxiosInstance, AxiosResponse, AxiosError } from "axios";
import { Config } from "../../config";
import { Logger } from "../../logger";
import { injectTraceContextHeaders } from "../../utils/context-propagation";
import {
  CreateRunRequestBody,
  CreateRunResponse,
  RedteamAuthError,
  RedteamConfigError,
  RedteamGenerationError,
  RedteamGenerationTimeoutError,
  RedteamRunError,
  RiskScore,
  RunProgress,
  RunPromptsResponse,
  RunResultsPage,
  SubmitTurnBody,
  SubmitTurnResult,
} from "./models";
import {
  getRedteamTimeoutMs,
  mapResultsPage,
  mapRiskScore,
  unwrapEnvelope,
} from "./utils";

const LOG_PREFIX = "netra.redteam";
const BASE_PATH = "/redteam/sdk";
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 200;

/**
 * Internal HTTP client for the red-team SDK API surface.
 *
 * Modeled on `SimulationHttpClient` (axios + request interceptor + envelope
 * unwrap conventions), but with an ordinary, short REST timeout — every
 * backend call is fast and bounded, there is no server-held-open wait to
 * accommodate.
 */
export class RedteamHttpClient {
  private client: AxiosInstance | null = null;

  constructor(config: Config) {
    this.client = this._createClient(config);
  }

  isInitialized(): boolean {
    return this.client !== null;
  }

  private _createClient(config: Config): AxiosInstance | null {
    const endpoint = (config.otlpEndpoint || "").trim();
    if (!endpoint) {
      Logger.error(`${LOG_PREFIX}: NETRA_OTLP_ENDPOINT is required`);
      return null;
    }

    const baseURL = this._resolveBaseUrl(endpoint);
    const headers = this._buildHeaders(config);
    const timeout = getRedteamTimeoutMs();

    try {
      const instance = axios.create({ baseURL, headers, timeout });

      instance.interceptors.request.use(
        (cfg) => {
          const traceHeaders = injectTraceContextHeaders({});
          Object.assign(cfg.headers, traceHeaders);
          return cfg;
        },
        (error) => Promise.reject(error),
      );

      return instance;
    } catch (error) {
      Logger.error(`${LOG_PREFIX}: Failed to create HTTP client:`, error);
      return null;
    }
  }

  /** Strip a trailing `/` and a trailing `/telemetry` from the configured endpoint. */
  private _resolveBaseUrl(endpoint: string): string {
    let baseUrl = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
    if (baseUrl.endsWith("/telemetry")) {
      baseUrl = baseUrl.slice(0, -"/telemetry".length);
    }
    return baseUrl;
  }

  private _buildHeaders(config: Config): Record<string, string> {
    const headers: Record<string, string> = { ...config.headers };
    if (config.apiKey) {
      headers["x-api-key"] = config.apiKey;
    }
    return headers;
  }

  private _ensureClient(): AxiosInstance {
    if (!this.client) {
      throw new RedteamAuthError("Netra red-team client is not initialized (NETRA_OTLP_ENDPOINT required)");
    }
    return this.client;
  }

  // -------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------

  /** `POST /redteam/sdk/runs` — create/start (or continue generating) a run. */
  async createRun(body: CreateRunRequestBody): Promise<CreateRunResponse> {
    try {
      return await this._withRetry(async () => {
        const client = this._ensureClient();
        const response: AxiosResponse = await client.post(`${BASE_PATH}/runs`, body);
        return unwrapEnvelope<CreateRunResponse>(response.data);
      });
    } catch (error) {
      throw this._toTypedError(error);
    }
  }

  /**
   * `GET /redteam/sdk/runs/{runId}/prompts`
   *
   * Fetched ONCE per run — the entire generated prompt list, in one call. No
   * per-turn polling, no server-side claim of any kind: the client drives
   * every session's turns itself from this list.
   */
  async getPrompts(runId: string): Promise<RunPromptsResponse> {
    try {
      return await this._withRetry(async () => {
        const client = this._ensureClient();
        const response: AxiosResponse = await client.get(`${BASE_PATH}/runs/${runId}/prompts`);
        return unwrapEnvelope<RunPromptsResponse>(response.data);
      });
    } catch (error) {
      throw this._toTypedError(error);
    }
  }

  /**
   * `POST /redteam/sdk/runs/{runId}/turns`
   *
   * Not retried: an exact-duplicate (run, promptId, turnIndex) submission
   * returns a clean `409` (a network-retry guard, since there is no
   * persisted claim to check against) — this method surfaces that as
   * `{done: true}` rather than throwing, since a duplicate of an already-
   * accepted turn means this session's work here is already recorded.
   */
  async submitTurn(runId: string, body: SubmitTurnBody): Promise<SubmitTurnResult> {
    try {
      const client = this._ensureClient();
      const response: AxiosResponse = await client.post(`${BASE_PATH}/runs/${runId}/turns`, body);
      return unwrapEnvelope<SubmitTurnResult>(response.data);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        Logger.debug(
          `${LOG_PREFIX}: turn (promptId=${body.promptId}, turnIndex=${body.turnIndex}) already submitted; treating as done`,
        );
        return { done: true };
      }
      throw this._toTypedError(error);
    }
  }

  /** `GET /redteam/sdk/runs/{runId}/progress` */
  async getProgress(runId: string): Promise<RunProgress> {
    try {
      return await this._withRetry(async () => {
        const client = this._ensureClient();
        const response: AxiosResponse = await client.get(`${BASE_PATH}/runs/${runId}/progress`);
        return unwrapEnvelope(response.data) ?? {};
      });
    } catch (error) {
      throw this._toTypedError(error);
    }
  }

  /**
   * `GET /redteam/sdk/runs/{runId}/results?page&limit&evaluatorId` — one page.
   * Callers loop pages until `items.length < limit` (see `Redteam.getResults`
   * in `api.ts`).
   */
  async getResultsPage(
    runId: string,
    params: { page?: number; limit?: number; evaluatorId?: string } = {},
  ): Promise<RunResultsPage> {
    try {
      return await this._withRetry(async () => {
        const client = this._ensureClient();
        const response: AxiosResponse = await client.get(`${BASE_PATH}/runs/${runId}/results`, {
          params: {
            page: params.page ?? 1,
            limit: params.limit ?? 200,
            evaluatorId: params.evaluatorId,
          },
        });
        return mapResultsPage(unwrapEnvelope(response.data));
      });
    } catch (error) {
      throw this._toTypedError(error);
    }
  }

  /** `GET /redteam/sdk/configs/{configId}/risk-score` */
  async getRiskScore(configId: string): Promise<RiskScore> {
    try {
      return await this._withRetry(async () => {
        const client = this._ensureClient();
        const response: AxiosResponse = await client.get(
          `${BASE_PATH}/configs/${configId}/risk-score`,
        );
        return mapRiskScore(unwrapEnvelope(response.data));
      });
    } catch (error) {
      throw this._toTypedError(error);
    }
  }

  /** `POST /redteam/sdk/runs/{runId}/cancel` */
  async cancel(runId: string): Promise<{ status: "cancelled" }> {
    try {
      const client = this._ensureClient();
      const response: AxiosResponse = await client.post(`${BASE_PATH}/runs/${runId}/cancel`);
      return unwrapEnvelope(response.data);
    } catch (error) {
      throw this._toTypedError(error);
    }
  }

  // -------------------------------------------------------------------------
  // Retry + error mapping
  // -------------------------------------------------------------------------

  /** Bounded retry (max 2) with linear backoff on network errors / 5xx / timeout. Never retries 4xx. */
  private async _withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (!this._isRetryable(error) || attempt === MAX_RETRIES) {
          throw error;
        }
        const delay = RETRY_BASE_DELAY_MS * (attempt + 1);
        Logger.debug(`${LOG_PREFIX}: retrying after error (attempt ${attempt + 1}/${MAX_RETRIES}):`, error);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  private _isRetryable(error: unknown): boolean {
    if (axios.isAxiosError(error)) {
      if (!error.response) {
        // Network error / timeout — no response received.
        return true;
      }
      const status = error.response.status;
      return status === 502 || status === 503 || status >= 500;
    }
    return false;
  }

  /**
   * Extract a human-readable message from an axios error or ErrorEnvelope,
   * covering 400/401/403/404/409/422/502/503.
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
          return responseData.error.message || responseData.error.error || error.message;
        }
      }
      return axiosError.message;
    }
    return error?.message || String(error);
  }

  /** Map a raw axios/HTTP error to a typed red-team error. */
  private _toTypedError(error: unknown): Error {
    if (error instanceof Error && !axios.isAxiosError(error)) {
      return error;
    }

    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const message = this._extractErrorMessage(error);

    switch (status) {
      case 400:
        return new RedteamConfigError(message || "invalid request: configId is required");
      case 401:
        return new RedteamAuthError(message || "check NETRA_API_KEY");
      case 403:
        return new RedteamAuthError(message || "red-teaming not enabled for this org");
      case 404:
        return new RedteamConfigError(message || "config not found or not in this project");
      case 409:
        return new RedteamRunError(message || "a run is already active for this config");
      case 422:
        return new RedteamConfigError(
          message || "agent is missing application details (systemPrompt)",
        );
      case 502:
        return new RedteamGenerationError(message || "prompt generation failed");
      case 503:
        return new RedteamGenerationTimeoutError(
          message || "generation did not complete (worker unavailable?)",
        );
      default:
        return error instanceof Error ? error : new Error(message);
    }
  }
}
