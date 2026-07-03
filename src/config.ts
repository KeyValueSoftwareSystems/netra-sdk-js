/**
 * Configuration management for Netra SDK
 */

import { Logger } from "./logger";
import { SDK_VERSION } from "./version";

export interface NetraConfig {
  appName?: string;
  headers?: string | Record<string, string>;
  disableBatch?: boolean;
  traceContent?: boolean;
  debugMode?: boolean;
  enableRootSpan?: boolean;
  resourceAttributes?: Record<string, any>;
  environment?: string;
  enableScrubbing?: boolean;
  blockedSpans?: string[];
  instruments?: Set<NetraInstruments>;
  blockInstruments?: Set<NetraInstruments>;
  rootInstruments?: Set<NetraInstruments>;
}

export enum NetraInstruments {
  /**
   * Sentinel value: when included in `instruments` or `rootInstruments`,
   * restores the legacy behaviour where every available instrumentation is
   * enabled automatically (no curated default list is applied).
   */
  ALL = "__all__",

  // LLM Providers
  OPENAI = "openai",
  GOOGLE_GENERATIVE_AI = "google_generative_ai",
  MISTRAL = "mistral_ai",
  GROQ = "groq",
  VERTEX_AI = "vertexai",
  TOGETHER = "together",
  ANTHROPIC = "anthropic",

  // AI Frameworks
  LANGCHAIN = "langchain",
  LANGGRAPH = "langgraph",
  LLAMA_INDEX = "llama_index",
  OPENAI_AGENTS = "openai_agents",

  // Vector DBs
  PINECONE = "pinecone",
  QDRANT = "qdrant",
  CHROMADB = "chromadb",

  // HTTP Clients
  HTTP = "http",

  // Databases
  PRISMA = "prisma",
  TYPEORM = "typeorm",

  // Web Frameworks
  EXPRESS = "express",
}

/**
 * Subset of DEFAULT_INSTRUMENTS allowed to produce root-level spans.
 * Covers core LLM/AI providers and agent frameworks.
 */
export const DEFAULT_INSTRUMENTS_FOR_ROOT: Set<NetraInstruments> = new Set([
  // LLM / AI providers
  NetraInstruments.OPENAI,
  NetraInstruments.ANTHROPIC,
  NetraInstruments.GROQ,
  NetraInstruments.MISTRAL,
  NetraInstruments.GOOGLE_GENERATIVE_AI,
  NetraInstruments.VERTEX_AI,
  NetraInstruments.TOGETHER,
  // AI frameworks
  NetraInstruments.LANGCHAIN,
  NetraInstruments.LANGGRAPH,
  NetraInstruments.LLAMA_INDEX,
  NetraInstruments.OPENAI_AGENTS,
]);

/**
 * Full set of instrumentations installed by default. Includes the root
 * defaults plus common vector DBs, HTTP clients, and database libraries.
 */
export const DEFAULT_INSTRUMENTS: Set<NetraInstruments> = new Set([
  ...DEFAULT_INSTRUMENTS_FOR_ROOT,
  // Vector DBs
  NetraInstruments.PINECONE,
  NetraInstruments.QDRANT,
  NetraInstruments.CHROMADB,
  // HTTP
  NetraInstruments.HTTP,
  // Databases
  NetraInstruments.PRISMA,
  NetraInstruments.TYPEORM,
  // Web Frameworks
  NetraInstruments.EXPRESS,
]);

export class Config {
  static readonly SDK_NAME = "netra";
  static readonly LIBRARY_NAME = "netra";
  static readonly LIBRARY_VERSION = SDK_VERSION;
  static readonly TRIAL_BLOCK_DURATION_SECONDS = 900; // 15 minutes
  static readonly ATTRIBUTE_MAX_LEN = parseInt(
    process.env.NETRA_ATTRIBUTE_MAX_LEN || "50000",
  );
  static readonly CONVERSATION_MAX_LEN = parseInt(
    process.env.NETRA_CONVERSATION_CONTENT_MAX_LEN || "50000",
  );
  static readonly SPAN_ATTRIBUTE_MAX_SIZE = parseInt(
    process.env.NETRA_SPAN_ATTRIBUTE_MAX_SIZE || "30000",
  );

  appName: string;
  otlpEndpoint?: string;
  apiKey?: string;
  headers: Record<string, string>;
  disableBatch: boolean;
  traceContent: boolean;
  debugMode: boolean;
  enableRootSpan: boolean;
  enableScrubbing: boolean;
  environment: string;
  resourceAttributes: Record<string, any>;
  blockedSpans?: string[];

  constructor(config: NetraConfig = {}) {
    this.appName = this._getAppName(config.appName);
    this.otlpEndpoint = this._getOtlpEndpoint();
    this.apiKey = process.env.NETRA_API_KEY;
    this.headers = this._parseHeaders(config.headers);
    this.disableBatch = this._getBoolConfig(
      config.disableBatch,
      "NETRA_DISABLE_BATCH",
      false,
    );
    this.traceContent = this._getBoolConfig(
      config.traceContent,
      "NETRA_TRACE_CONTENT",
      true,
    );
    this.debugMode = this._getBoolConfig(
      config.debugMode,
      "NETRA_DEBUG",
      false,
    );
    this.enableRootSpan = this._getBoolConfig(
      config.enableRootSpan,
      "NETRA_ENABLE_ROOT_SPAN",
      false,
    );
    this.enableScrubbing = this._getBoolConfig(
      config.enableScrubbing,
      "NETRA_ENABLE_SCRUBBING",
      false,
    );
    this.environment = config.environment || process.env.NETRA_ENV || "local";
    this.resourceAttributes = this._getResourceAttributes(
      config.resourceAttributes,
    );
    this.blockedSpans = config.blockedSpans;

    this._validateApiKey();
    this._setupAuthentication();
    this._setTraceContentEnv();
  }

  private _getAppName(appName?: string): string {
    return (
      appName ||
      process.env.NETRA_APP_NAME ||
      process.env.OTEL_SERVICE_NAME ||
      process.env.npm_package_name ||
      "llm_tracing_service"
    );
  }

  private _getOtlpEndpoint(): string | undefined {
    return (
      process.env.NETRA_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    );
  }

  private _parseHeaders(
    headers?: string | Record<string, string>,
  ): Record<string, string> {
    if (!headers) {
      const envHeaders = process.env.NETRA_HEADERS;
      if (envHeaders) {
        return this._parseEnvHeaders(envHeaders);
      }
      return {};
    }

    if (typeof headers === "string") {
      return this._parseEnvHeaders(headers);
    }

    return headers;
  }

  private _parseEnvHeaders(headers: string): Record<string, string> {
    const result: Record<string, string> = {};
    const pairs = headers.split(",");
    for (const pair of pairs) {
      const [key, ...valueParts] = pair.split("=");
      if (key && valueParts.length > 0) {
        result[key.trim()] = valueParts.join("=").trim();
      }
    }
    return result;
  }

  private _validateApiKey(): void {
    if (
      this.otlpEndpoint &&
      this.otlpEndpoint.toLowerCase().includes("getnetra") &&
      !this.apiKey
    ) {
      Logger.error(
        "Error: Missing Netra API key, go to netra dashboard to create one",
      );
      Logger.error("Set the NETRA_API_KEY environment variable to the key");
    }
  }

  private _setupAuthentication(): void {
    if (!this.apiKey || !this.otlpEndpoint) {
      return;
    }

    const isNetra = this.otlpEndpoint.toLowerCase().includes("getnetra");
    const authKey = isNetra ? "x-api-key" : "Authorization";
    const authValue = isNetra ? this.apiKey : `Bearer ${this.apiKey}`;

    if (!this.headers[authKey]) {
      this.headers[authKey] = authValue;
    }
  }

  private _getBoolConfig(
    param: boolean | undefined,
    envVar: string,
    defaultValue: boolean,
  ): boolean {
    if (param !== undefined) {
      return param;
    }

    const envValue = process.env[envVar];
    if (envValue === undefined) {
      return defaultValue;
    }

    return ["1", "true"].includes(envValue.toLowerCase());
  }

  private _getResourceAttributes(
    resourceAttributes?: Record<string, any>,
  ): Record<string, any> {
    if (resourceAttributes !== undefined) {
      return resourceAttributes;
    }

    const envRa = process.env.NETRA_RESOURCE_ATTRS;
    if (!envRa) {
      return {};
    }

    try {
      return JSON.parse(envRa);
    } catch (e) {
      Logger.warn(`Failed to parse NETRA_RESOURCE_ATTRS: ${e}`);
      return {};
    }
  }

  private _setTraceContentEnv(): void {
    process.env.TRACELOOP_TRACE_CONTENT = this.traceContent ? "true" : "false";
  }

  /**
   * Format the OTLP endpoint URL by appending /v1/traces if not already present
   */
  public formatOtlpEndpoint(): any {
    if (!this.otlpEndpoint) {
      return undefined;
    }

    const url = this.otlpEndpoint.trim();

    // Remove trailing slash if present
    const cleanUrl = url.endsWith("/") ? url.slice(0, -1) : url;

    // Append /v1/traces if not already present
    if (!cleanUrl.endsWith("/v1/traces")) {
      return `${cleanUrl}/v1/traces`;
    }

    return cleanUrl;
  }

  /**
   * Set Traceloop environment variables based on Netra config.
   * This ensures the Traceloop SDK picks up our configuration.
   */
  public setTraceloopEnv(): void {
    // Set TRACELOOP_BASE_URL so Traceloop SDK uses our endpoint
    if (this.otlpEndpoint && !process.env.TRACELOOP_BASE_URL) {
      process.env.TRACELOOP_BASE_URL = this.otlpEndpoint;
    }

    // Set TRACELOOP_API_KEY if we have one
    if (this.apiKey && !process.env.TRACELOOP_API_KEY) {
      process.env.TRACELOOP_API_KEY = this.apiKey;
    }

    // Set headers for Traceloop
    if (
      Object.keys(this.headers).length > 0 &&
      !process.env.TRACELOOP_HEADERS
    ) {
      const headerStr = Object.entries(this.headers)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      process.env.TRACELOOP_HEADERS = headerStr;
    }

    // Set OTEL_RESOURCE_ATTRIBUTES so the TracerProvider Resource carries
    // service.name and deployment.environment attributes.
    this._setResourceAttributesEnv();
  }

  private _setResourceAttributesEnv(): void {
    // Start with Netra defaults (lowest priority)
    const attrs: Record<string, string> = {
      "deployment.environment": this.environment,
      "service.name": this.appName,
    };

    // Config-level resourceAttributes override defaults
    for (const [k, v] of Object.entries(this.resourceAttributes)) {
      attrs[k] = String(v);
    }

    // Pre-existing OTEL_RESOURCE_ATTRIBUTES win (highest priority)
    const existing = process.env.OTEL_RESOURCE_ATTRIBUTES;
    if (existing) {
      for (const pair of existing.split(",")) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx <= 0) continue;
        const key = decodeURIComponent(pair.slice(0, eqIdx).trim());
        if (key) {
          attrs[key] = decodeURIComponent(pair.slice(eqIdx + 1).trim());
        }
      }
    }

    const encodeAttrValue = (s: string) => encodeURIComponent(s);

    process.env.OTEL_RESOURCE_ATTRIBUTES = Object.entries(attrs)
      .map(([k, v]) => `${encodeAttrValue(k)}=${encodeAttrValue(v)}`)
      .join(",");
  }
}
