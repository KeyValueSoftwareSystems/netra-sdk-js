/**
 * Base HTTP client for Netra API calls
 */

import { Config } from "../config";
import { Logger } from "../logger";

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

export class NetraHttpClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;
  private initialized: boolean = false;

  constructor(config: Config, timeoutEnvVar: string, defaultTimeout: number) {
    const endpoint = config.otlpEndpoint?.trim() || "";
    if (!endpoint) {
      Logger.error(
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
      Logger.warn(
        `netra: Invalid ${envVar} value '${envValue}', using default ${defaultValue}`
      );
      return defaultValue;
    }
    return parsed;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async get<T = any>(
    path: string,
    params?: Record<string, string | number | undefined>
  ): Promise<HttpResponse<T>> {
    if (!this.initialized) {
      Logger.error("netra: HTTP client is not initialized");
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
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.timeout * 1000
      );

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: this.headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await response.json();
      return {
        data,
        status: response.status,
        ok: response.ok,
      };
    } catch (error) {
      Logger.error(`netra: GET ${path} failed:`, error);
      return { data: {} as T, status: 0, ok: false };
    }
  }

  async post<T = any>(
    path: string,
    body?: Record<string, any>
  ): Promise<HttpResponse<T>> {
    if (!this.initialized) {
      Logger.error("netra: HTTP client is not initialized");
      return { data: {} as T, status: 0, ok: false };
    }

    const url = new URL(path, this.baseUrl);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.timeout * 1000
      );

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: this.headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await response.json();
      return {
        data,
        status: response.status,
        ok: response.ok,
      };
    } catch (error) {
      Logger.error(`netra: POST ${path} failed:`, error);
      return { data: {} as T, status: 0, ok: false };
    }
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
