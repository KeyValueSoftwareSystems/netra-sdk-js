/**
 * Configuration management for Netra SDK
 */

import { Logger } from "./logger";

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
}

export enum NetraInstruments {
  // LLM Providrs
  OPENAI = "openai",
  GOOGLE_GENERATIVE_AI = "google_genai",
  MISTRAL = "mistral",
  GROQ = "groq",
  VERTEX_AI = "vertexai",
  TOGETHER = "together",
  ANTHROPIC = "anthropic",

  // AI Frameworks
  LANGCHAIN = "langchain",
  LANGGRAPH = "langgraph",
  LLAMA_INDEX = "llama_index",
  OPENAI_AGENTS = "openai_agents",

  // Vector Dbs
  PINECONE = "pinecone",
  QDRANT = "qdrant",
  CHROMADB = "chromadb",

  // HTTP Clients
  HTTP = "http",
  HTTPS = "https",
  FETCH = "fetch",

  // Databases
  PRISMA = "prisma",
  TYPEORM = "typeorm",
  MONGODB = "mongodb",
  POSTGRES = "postgres",
  MYSQL = "mysql",
  REDIS = "redis",

  // Web Frameworks
  EXPRESS = "express",
  FASTIFY = "fastify",
  NESTJS = "nestjs",

  KAFKA = "kafka",
  RABBITMQ = "rabbitmq",
}

export class Config {
  static readonly SDK_NAME = "netra";
  static readonly LIBRARY_NAME = "netra";
  static readonly LIBRARY_VERSION = "1.0.0";
  static readonly TRIAL_BLOCK_DURATION_SECONDS = 900; // 15 minutes
  static readonly ATTRIBUTE_MAX_LEN = parseInt(
    process.env.NETRA_ATTRIBUTE_MAX_LEN || "50000",
  );
  static readonly CONVERSATION_MAX_LEN = parseInt(
    process.env.NETRA_CONVERSATION_CONTENT_MAX_LEN || "50000",
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
  }
}
