/**
 * Configuration management for Netra SDK
 */

import { setTraceContentEnabled } from "./instrumentation/utils";
import { NetraLogger } from "./netraLogger";
import { SDK_VERSION } from "./version";

// The only header the Netra backend's API-key guard reads. Lowercase, for case-insensitive matching.
const NETRA_API_KEY_HEADER = "x-api-key";
const NETRA_HOST_SUFFIX = "getnetra.ai";

/**
 * True when `endpoint` is a Netra-hosted URL (`getnetra.ai` or a subdomain).
 * Decided on the parsed hostname: a substring test on the whole URL would
 * also match `https://collector.example/getnetra` (JS-SEC-006).
 */
export function isNetraHost(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  try {
    const host = new URL(endpoint.trim()).hostname.toLowerCase();
    return host === NETRA_HOST_SUFFIX || host.endsWith(`.${NETRA_HOST_SUFFIX}`);
  } catch {
    return false;
  }
}

/** decodeURIComponent that returns the input unchanged on malformed escapes (JS-PERF-008). */
function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface NetraConfig {
  appName?: string;
  headers?: string | Record<string, string>;
  disableBatch?: boolean;
  traceContent?: boolean;
  debugMode?: boolean;
  resourceAttributes?: Record<string, any>;
  environment?: string;
  enableScrubbing?: boolean;
  blockedSpans?: string[];
  instruments?: Set<NetraInstruments>;
  blockInstruments?: Set<NetraInstruments>;
  /**
   * Set of instruments allowed to produce root-level spans. Independent of
   * `instruments`. Defaults to `DEFAULT_INSTRUMENTS_FOR_ROOT` when omitted.
   *
   * When a root span comes from an instrumentation outside this set, only that
   * span is dropped — its children are reparented onto its parent (a true
   * root's children become the new roots). The peel then repeats: if a promoted
   * child is itself from a non-root instrumentation it is dropped too,
   * recursively, until a surviving span is reached (an allowed instrument, a
   * Netra decorator / manual span, or any non-instrumentation span). This keeps
   * LLM/vector spans that originate under an unwanted server root (e.g.
   * Express/HTTP) without emitting the server span itself. A span whose parent
   * link is remote (cross-process) is kept as a root so an upstream distributed
   * trace is not severed.
   *
   * Pass a set containing `NetraInstruments.ALL` to allow all instrumentations
   * to produce root spans (legacy behaviour).
   */
  rootInstruments?: Set<NetraInstruments>;
  /**
   * Register process hooks (`SIGINT`, `SIGTERM`, `uncaughtException`,
   * `beforeExit`) that flush pending spans when the process is going away.
   * The hooks never exit the process themselves while the application has
   * its own handlers for the same event. Defaults to `true`; set to `false`
   * to manage shutdown yourself via `Netra.shutdown()`.
   *
   * This covers the span-flushing hooks only. A simulation run still registers
   * short-lived exit hooks of its own so an interrupted run is marked `failed`
   * instead of being left `running`; those are removed when the run ends and
   * likewise never override an application that handles the event itself.
   */
  registerShutdownHooks?: boolean;
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
  GOOGLE_GENAI = "google_genai",
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
  NetraInstruments.GOOGLE_GENAI,
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

  // Root-span attribute marking traces produced by evaluation/simulation runs
  // so the FE/BE can distinguish them from normal workflow invocations.
  static readonly TRACE_ORIGIN_KEY = "netra.trace.origin";
  static readonly TRACE_ORIGIN_EVALUATION = "evaluation";

  private static _spanAttributeMaxSize: number | undefined;

  /**
   * Lazily reads NETRA_SPAN_ATTRIBUTE_MAX_SIZE from process.env on first
   * access so that env vars set before Netra.init() (via dotenv, shell
   * export, Docker, etc.) are always respected regardless of import order.
   */
  static get SPAN_ATTRIBUTE_MAX_SIZE(): number {
    if (Config._spanAttributeMaxSize === undefined) {
      Config._spanAttributeMaxSize = parseInt(
        process.env.NETRA_SPAN_ATTRIBUTE_MAX_SIZE || "30000",
      );
    }
    return Config._spanAttributeMaxSize;
  }

  appName: string;
  otlpEndpoint?: string;
  /** Which variable `otlpEndpoint` came from. */
  otlpEndpointSource?: "NETRA_OTLP_ENDPOINT" | "OTEL_EXPORTER_OTLP_ENDPOINT";
  apiKey?: string;
  headers: Record<string, string>;
  disableBatch: boolean;
  traceContent: boolean;
  debugMode: boolean;
  enableScrubbing: boolean;
  environment: string;
  resourceAttributes: Record<string, any>;
  blockedSpans?: string[];

  constructor(config: NetraConfig = {}) {
    this.appName = this._getAppName(config.appName);
    this.otlpEndpoint = this._getOtlpEndpoint();
    this.apiKey = this._getApiKey();
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
    // Kept in-process, not in TRACELOOP_TRACE_CONTENT: overwriting that shared
    // env var changed other tracing tools' behaviour and leaked into child
    // processes (JS-SEC-007).
    setTraceContentEnabled(this.traceContent);
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
    if (process.env.NETRA_OTLP_ENDPOINT) {
      this.otlpEndpointSource = "NETRA_OTLP_ENDPOINT";
      return process.env.NETRA_OTLP_ENDPOINT;
    }
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      this.otlpEndpointSource = "OTEL_EXPORTER_OTLP_ENDPOINT";
      return process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    }
    return undefined;
  }

  /**
   * NETRA_API_KEY, unless the endpoint only came from the generic
   * OTEL_EXPORTER_OTLP_ENDPOINT and is not a Netra host. That variable usually
   * points at another vendor or a shared collector, which must not receive a
   * working Netra key (JS-SEC-006). An explicit NETRA_OTLP_ENDPOINT, including
   * a self-hosted Netra, keeps receiving it.
   */
  private _getApiKey(): string | undefined {
    const key = process.env.NETRA_API_KEY;
    if (
      key &&
      this.otlpEndpointSource === "OTEL_EXPORTER_OTLP_ENDPOINT" &&
      !isNetraHost(this.otlpEndpoint)
    ) {
      let host = "that endpoint";
      try { host = new URL(String(this.otlpEndpoint).trim()).host; } catch { /* keep generic */ }
      NetraLogger.notice(
        "warn",
        `NETRA_API_KEY is not sent to ${host}: it comes from OTEL_EXPORTER_OTLP_ENDPOINT and is not a Netra endpoint. ` +
          "Fix: set NETRA_OTLP_ENDPOINT to https://api.getnetra.ai/telemetry (or your Netra endpoint).",
      );
      return undefined;
    }
    return key;
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

    // A copy: authentication headers are added below, and must not be written
    // into the object the application passed in (JS-SEC-022).
    return { ...headers };
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

  /**
   * Warn when a Netra endpoint has no API key. The key counts as present when
   * it is set via NETRA_API_KEY or already passed as an `x-api-key` header
   * (through `headers` or NETRA_HEADERS); header names match case-insensitively.
   */
  private _validateApiKey(): void {
    if (!this.otlpEndpoint || !isNetraHost(this.otlpEndpoint) || this.apiKey) {
      return;
    }
    const hasApiKeyHeader = Object.keys(this.headers).some(
      (name) => name.toLowerCase() === NETRA_API_KEY_HEADER,
    );
    if (hasApiKeyHeader) {
      return;
    }
    NetraLogger.notice("error",
      "NETRA_API_KEY is not set, so Netra will reject the traces this app sends. " +
        "Fix: create an API key in the Netra dashboard and set NETRA_API_KEY to it.",
    );
  }

  private _setupAuthentication(): void {
    if (!this.apiKey || !this.otlpEndpoint) {
      return;
    }

    const isNetra = isNetraHost(this.otlpEndpoint);
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
      NetraLogger.notice("warn", `Failed to parse NETRA_RESOURCE_ATTRS: ${e}`);
      return {};
    }
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
   * Prepare the environment for Traceloop's `initialize()` and return a
   * function that restores it. Call the restore function right after
   * `initialize()` returns.
   *
   * Only OTEL_RESOURCE_ATTRIBUTES is set: Traceloop's NodeSDK reads it while
   * starting, which is how service.name, deployment.environment and custom
   * resource attributes reach the Resource. Restoring it afterwards keeps it
   * out of child processes. The endpoint, API key and headers are passed to
   * Traceloop directly and are no longer copied into TRACELOOP_* variables,
   * which every child process inherited (JS-SEC-007).
   */
  public setTraceloopEnv(): () => void {
    const previous = process.env.OTEL_RESOURCE_ATTRIBUTES;
    this._setResourceAttributesEnv();
    return () => {
      if (previous === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES;
      else process.env.OTEL_RESOURCE_ATTRIBUTES = previous;
    };
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
        const key = safeDecodeURIComponent(pair.slice(0, eqIdx).trim());
        if (key) {
          attrs[key] = safeDecodeURIComponent(pair.slice(eqIdx + 1).trim());
        }
      }
    }

    const encodeAttrValue = (s: string) => encodeURIComponent(s);

    process.env.OTEL_RESOURCE_ATTRIBUTES = Object.entries(attrs)
      .map(([k, v]) => `${encodeAttrValue(k)}=${encodeAttrValue(v)}`)
      .join(",");
  }
}
