/**
 * Base HTTP client for Netra API calls
 */

import { Config } from "../config";
import { NetraLogger } from "../netraLogger";
import { apiPath } from "../utils/api-path";
import { injectTraceContextHeaders } from "../utils/context-propagation";

export interface HttpClientConfig {
  baseUrl: string;
  headers: Record<string, string>;
  timeout: number;
}

export interface HttpResponse<T = any> {
  data: T;
  status: number;
  ok: boolean;
}

const MAX_GET_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
const MAX_REDIRECTS = 3;
/** API responses larger than this are rejected rather than buffered. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/** Read a response body as text, failing once it passes `maxBytes`. */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`response of ${declared} bytes exceeds the ${maxBytes}-byte limit`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class NetraHttpClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;
  private initialized: boolean = false;

  constructor(config: Config, timeoutEnvVar: string, defaultTimeout: number) {
    const endpoint = config.otlpEndpoint?.trim() || "";
    if (!endpoint) {
      // Debug only: init already shows one MISSING_ENDPOINT_NOTICE covering API
      // calls, instead of one line per API client.
      NetraLogger.debug(
        "netra: NETRA_OTLP_ENDPOINT is required for API calls"
      );
      this.baseUrl = "";
      this.headers = {};
      this.timeout = defaultTimeout;
      return;
    }

    this.baseUrl = this.resolveBaseUrl(endpoint);
    this.headers = this.buildHeaders(config);
    this.timeout = this.getTimeout(timeoutEnvVar, defaultTimeout);
    this.initialized = true;
  }

  private resolveBaseUrl(endpoint: string): string {
    let baseUrl = endpoint.replace(/\/+$/, "");
    if (baseUrl.endsWith("/telemetry")) {
      baseUrl = baseUrl.slice(0, -"/telemetry".length);
    }
    return baseUrl;
  }

  private buildHeaders(config: Config): Record<string, string> {
    const headers: Record<string, string> = { ...config.headers };
    if (config.apiKey) {
      headers["x-api-key"] = config.apiKey;
    }
    headers["Content-Type"] = "application/json";
    return headers;
  }

  private getTimeout(envVar: string, defaultValue: number): number {
    const envValue = process.env[envVar];
    if (!envValue) {
      return defaultValue;
    }
    const parsed = parseFloat(envValue);
    if (isNaN(parsed)) {
      NetraLogger.notice("warn",
        `netra: Invalid ${envVar} value '${envValue}', using default ${defaultValue}`
      );
      return defaultValue;
    }
    return parsed;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Build an API path, percent-encoding every interpolated value.
   * Returns null (and logs) if a value is not a valid path segment;
   * `get`/`post` treat a null path as a failed request.
   */
  protected path(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): string | null {
    try {
      return apiPath(strings, ...values);
    } catch (error) {
      NetraLogger.notice("error", `netra: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  async get<T = any>(
    path: string | null,
    params?: Record<string, string | number | undefined>
  ): Promise<HttpResponse<T>> {
    if (!this.initialized) {
      NetraLogger.notice("error", "netra: HTTP client is not initialized");
      return { data: {} as T, status: 0, ok: false };
    }
    if (path === null) {
      return { data: {} as T, status: 0, ok: false };
    }

    const url = new URL(path, this.baseUrl);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    try {
      return await this.request<T>("GET", url);
    } catch (error) {
      NetraLogger.notice("error", `netra: GET ${path} failed:`, error);
      return { data: {} as T, status: 0, ok: false };
    }
  }

  async post<T = any>(
    path: string | null,
    body?: Record<string, any>
  ): Promise<HttpResponse<T>> {
    if (!this.initialized) {
      NetraLogger.notice("error", "netra: HTTP client is not initialized");
      return { data: {} as T, status: 0, ok: false };
    }
    if (path === null) {
      return { data: {} as T, status: 0, ok: false };
    }

    const url = new URL(path, this.baseUrl);

    try {
      return await this.request<T>("POST", url, body ? JSON.stringify(body) : undefined);
    } catch (error) {
      NetraLogger.notice("error", `netra: POST ${path} failed:`, error);
      return { data: {} as T, status: 0, ok: false };
    }
  }

  /**
   * One API call within `this.timeout` seconds, body read included
   * (JS-PERF-009). GETs are retried on network errors, 429 and 502/503/504;
   * POSTs are not, since they may not be idempotent. Redirects are followed
   * only within the API's own origin, so `x-api-key` never reaches another
   * host (JS-SEC-017).
   */
  private async request<T>(method: "GET" | "POST", url: URL, body?: string): Promise<HttpResponse<T>> {
    const deadline = Date.now() + this.timeout * 1000;
    const maxAttempts = method === "GET" ? MAX_GET_ATTEMPTS : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), remaining);
      try {
        const response = await this.fetchSameOrigin(url, {
          method,
          headers: injectTraceContextHeaders(this.headers),
          body,
          signal: controller.signal,
        });
        const text = await readBodyCapped(response, MAX_RESPONSE_BYTES);
        if (method === "GET" && RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts) {
          lastError = new Error(`HTTP ${response.status}`);
        } else {
          return {
            data: (text ? JSON.parse(text) : {}) as T,
            status: response.status,
            ok: response.ok,
          };
        }
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted || attempt >= maxAttempts) break;
      } finally {
        // Always cleared: a timer left armed after a failed request kept the
        // process alive for up to the full timeout.
        clearTimeout(timeoutId);
      }
      const wait = Math.round(RETRY_BASE_MS * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4));
      if (Date.now() + wait >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    throw lastError ?? new Error(`timed out after ${this.timeout}s`);
  }

  private async fetchSameOrigin(url: URL, init: RequestInit): Promise<Response> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetch(current.toString(), { ...init, redirect: "manual" });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      const next = new URL(location, current);
      if (next.origin !== current.origin) {
        throw new Error(`refusing to follow a redirect to another origin (${next.origin})`);
      }
      current = next;
    }
    throw new Error("too many redirects");
  }

  /**
   * Extract data from nested response format
   * Netra API typically returns { data: { data: actualData } }
   */
  extractData<T>(response: HttpResponse<any>, defaultValue: T): T {
    if (!response.ok) {
      return defaultValue;
    }
    const data = response.data;
    if (data && typeof data === "object" && "data" in data) {
      return data.data ?? defaultValue;
    }
    return data ?? defaultValue;
  }
}
