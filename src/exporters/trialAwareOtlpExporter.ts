import * as http from "http";
import * as https from "https";
import { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ExportResult, ExportResultCode } from "@opentelemetry/core";
import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import { NetraLogger } from "../netraLogger";
import { isTrialBlocked, setTrialBlocked } from "./utils";

const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413;
/** Longest excerpt of a non-JSON error body quoted in the export-failure debug message. */
const RESPONSE_EXCERPT_MAX_CHARS = 200;
const PAYLOAD_TOO_LARGE_HINT =
  "Lower OTEL_BSP_MAX_EXPORT_BATCH_SIZE or reduce large span attributes such as prompts and completions.";

/**
 * What the backend said, quoted: `error.message` from its error envelope (joined when it is a list
 * of validation messages), else an excerpt of the raw body.
 */
/**
 * Text from the endpoint, made safe to print: control characters (newlines,
 * ANSI escape sequences) are escaped and the length is capped, whether it came
 * from a JSON error message or a raw body. The endpoint may be any collector,
 * so its text must not be able to forge or flood log lines (JS-SEC-024).
 */
export function sanitizeForLog(text: string, maxChars = RESPONSE_EXCERPT_MAX_CHARS): string {
  const cut = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  return cut.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) =>
    c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function describeServerMessage(responseBody: string): string {
  try {
    const parsed: unknown = JSON.parse(responseBody);
    const message = (parsed as { error?: { message?: unknown } } | null)?.error
      ?.message;
    if (typeof message === "string") return `"${sanitizeForLog(message)}"`;
    if (Array.isArray(message) && message.every((m) => typeof m === "string")) {
      return `"${sanitizeForLog(message.join("; "))}"`;
    }
  } catch {
    // Not JSON: quote the raw body below.
  }
  const excerpt = sanitizeForLog(responseBody.trim());
  return excerpt ? `"${excerpt}"` : "(empty response body)";
}

/**
 * Debug message for a batch the backend rejected. The same format is used by netra-sdk-py's
 * TrialAwareOTLPExporter, so both SDKs report export failures identically.
 */
function formatExportFailure(
  statusCode: number | undefined,
  statusMessage: string | undefined,
  responseBody: string,
  spanCount: number,
  requestBytes: number,
): string {
  const status = [statusCode ?? "unknown", statusMessage ? sanitizeForLog(statusMessage, 80) : undefined]
    .filter(Boolean)
    .join(" ");
  const hint =
    statusCode === HTTP_STATUS_PAYLOAD_TOO_LARGE
      ? ` ${PAYLOAD_TOO_LARGE_HINT}`
      : "";
  return (
    `Span export failed with HTTP ${status}: ${describeServerMessage(responseBody)}. ` +
    `Dropped a batch of ${spanCount} spans (${requestBytes} bytes).${hint}`
  );
}

interface ExporterConfig {
  url: string;
  headers?: Record<string, string>;
  /** Overall deadline for one batch, all attempts included. */
  timeoutMillis?: number;
  /** Most exports sending at once; further batches wait in a bounded queue. */
  maxConcurrentExports?: number;
  /** Most batches allowed to wait for a free slot; beyond this they are dropped. */
  maxQueuedExports?: number;
}

const DEFAULT_EXPORT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENT_EXPORTS = 16;
const DEFAULT_MAX_QUEUED_EXPORTS = 1024;
const MAX_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5_000;
/** Error responses are only read for diagnostics; anything past this is ignored. */
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
/** Statuses worth retrying: the batch was not processed and may be next time. */
const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);
/** At most one "too many exports in flight" warning per interval. */
const SATURATION_NOTICE_INTERVAL_MS = 10_000;

/** Reads OTEL_EXPORTER_OTLP_TRACES_TIMEOUT / OTEL_EXPORTER_OTLP_TIMEOUT (ms). */
function timeoutFromEnv(): number | undefined {
  for (const name of ["OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "OTEL_EXPORTER_OTLP_TIMEOUT"]) {
    const value = Number(process.env[name]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** `Retry-After` in ms (delta-seconds or HTTP date), or undefined. */
function parseRetryAfter(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function backoffMs(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** (attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * The backend reports exhausted quota as `error.errorCode: "QUOTA_EXCEEDED"`
 * (combat-ai-core HttpExceptionFilter); netra-sdk-py checks
 * `error.error.code`. A plain 429 is a rate limit, not a quota block (JS-MEM-004).
 */
export function isQuotaExceededResponse(body: string): boolean {
  try {
    const error = (JSON.parse(body) as { error?: any } | null)?.error;
    if (!error || typeof error !== "object") return false;
    if (error.errorCode === "QUOTA_EXCEEDED" || error.code === "QUOTA_EXCEEDED") return true;
    if (error.error && typeof error.error === "object" && error.error.code === "QUOTA_EXCEEDED") return true;
    const message = Array.isArray(error.message) ? error.message.join(" ") : String(error.message ?? "");
    return message.toLowerCase().includes("usage quota exceeded");
  } catch {
    return false;
  }
}

interface AttemptResult {
  statusCode?: number;
  statusMessage?: string;
  body: string;
  retryAfterMs?: number;
  error?: Error;
}

export class TrialAwareOTLPExporter implements SpanExporter {
  private _url: string;
  private _headers: Record<string, string>;
  private _isShutdown = false;
  private readonly _timeoutMillis: number;
  private readonly _maxConcurrentExports: number;
  private readonly _maxQueuedExports: number;
  /** Every accepted batch until its callback has run (sending or queued). */
  private readonly _inFlight = new Set<Promise<void>>();
  private _sending = 0;
  private readonly _queue: Array<() => void> = [];
  private readonly _activeRequests = new Set<http.ClientRequest>();
  private readonly _sleepers = new Set<() => void>();
  /** Bumped by abortPending(); exports started before it stop retrying. */
  private _abortEpoch = 0;
  private _droppedSinceNotice = 0;
  private _lastSaturationNotice = 0;

  constructor(config: ExporterConfig) {
    this._url = config.url;
    // Copied so later changes to the caller's object do not leak into exports.
    this._headers = { ...(config.headers || {}) };
    this._timeoutMillis = config.timeoutMillis ?? timeoutFromEnv() ?? DEFAULT_EXPORT_TIMEOUT_MS;
    this._maxConcurrentExports = config.maxConcurrentExports ?? DEFAULT_MAX_CONCURRENT_EXPORTS;
    this._maxQueuedExports = config.maxQueuedExports ?? DEFAULT_MAX_QUEUED_EXPORTS;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    if (this._isShutdown || isTrialBlocked()) {
      return resultCallback({ code: ExportResultCode.SUCCESS });
    }

    if (this._sending >= this._maxConcurrentExports && this._queue.length >= this._maxQueuedExports) {
      // The endpoint is not keeping up (or hangs) and the queue is full.
      // Holding more batches would grow memory without bound (JS-MEM-002).
      this._droppedSinceNotice += spans.length;
      const now = Date.now();
      if (now - this._lastSaturationNotice >= SATURATION_NOTICE_INTERVAL_MS) {
        NetraLogger.notice(
          "warn",
          `Span export skipped: ${this._sending} exports in flight and ${this._queue.length} waiting. ` +
            `Dropped ${this._droppedSinceNotice} spans since the last warning.`,
        );
        this._lastSaturationNotice = now;
        this._droppedSinceNotice = 0;
      }
      return resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error("Too many exports in flight"),
      });
    }

    let data: Uint8Array;
    try {
      const serialized = ProtobufTraceSerializer.serializeRequest(spans);
      if (!serialized) throw new Error("Serialization failed");
      data = serialized;
    } catch (err) {
      return resultCallback({
        code: ExportResultCode.FAILED,
        error: err instanceof Error ? err : new Error("Serialization failed"),
      });
    }

    // The deadline starts now, so time spent queued counts against it.
    const deadline = Date.now() + this._timeoutMillis;
    const task = this._acquireSlot()
      .then(() => this._send(data, spans.length, deadline))
      .finally(() => this._releaseSlot())
      .then(resultCallback, (err) =>
        resultCallback({ code: ExportResultCode.FAILED, error: err instanceof Error ? err : new Error(String(err)) }),
      );
    this._inFlight.add(task);
    task.finally(() => this._inFlight.delete(task));
  }

  private _acquireSlot(): Promise<void> {
    if (this._sending < this._maxConcurrentExports) {
      this._sending++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this._queue.push(() => { this._sending++; resolve(); }));
  }

  private _releaseSlot(): void {
    this._sending--;
    const next = this._queue.shift();
    if (next) next();
  }

  /**
   * Send one batch with retries, all within `_timeoutMillis` (JS-PERF-003,
   * JS-PERF-006). Always settles.
   */
  private async _send(data: Uint8Array, spanCount: number, deadline: number): Promise<ExportResult> {
    let last: AttemptResult = { body: "" };
    let attempt = 0;
    const epoch = this._abortEpoch;
    const stopped = () => this._isShutdown || this._abortEpoch !== epoch;

    while (attempt < MAX_ATTEMPTS && !stopped()) {
      attempt++;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      last = await this._attempt(data, remaining);

      const status = last.statusCode;
      if (status !== undefined && status >= 200 && status < 300) {
        return { code: ExportResultCode.SUCCESS };
      }
      if (status !== undefined && isQuotaExceededResponse(last.body)) {
        setTrialBlocked(true);
        break;
      }
      const retryable = status === undefined || RETRYABLE_STATUSES.has(status);
      if (!retryable || attempt >= MAX_ATTEMPTS || stopped()) break;

      const wait = Math.max(backoffMs(attempt), last.retryAfterMs ?? 0);
      if (Date.now() + wait >= deadline) break;
      await this._sleep(wait);
    }

    const requestBytes = data.byteLength;
    const tries = attempt > 1 ? ` after ${attempt} attempts` : "";
    if (last.statusCode !== undefined) {
      // The batch is not retried further, so it is gone: always shown.
      NetraLogger.notice(
        "warn",
        formatExportFailure(last.statusCode, last.statusMessage, last.body, spanCount, requestBytes) +
          (tries ? ` (gave up${tries})` : ""),
      );
      return { code: ExportResultCode.FAILED, error: new Error(`Status ${last.statusCode}`) };
    }
    const error = last.error ?? new Error(stopped() ? "Export aborted" : "Export deadline exceeded");
    // No response (connection refused, DNS, TLS, socket reset, timeout): nothing else logs this.
    NetraLogger.notice(
      "warn",
      `Span export failed${tries}: ${error.message}. ` +
        `Dropped a batch of ${spanCount} spans (${requestBytes} bytes).`,
    );
    return { code: ExportResultCode.FAILED, error };
  }

  /** Backoff wait that ends early when the exporter shuts down. */
  private _sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this._sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this._sleepers.add(wake);
    });
  }

  /** One HTTP attempt, bounded by `timeoutMs`. Always settles exactly once. */
  private _attempt(data: Uint8Array, timeoutMs: number): Promise<AttemptResult> {
    return new Promise<AttemptResult>((resolve) => {
      const url = new URL(this._url);
      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          ...this._headers,
          host: url.host,
          "Content-Type": "application/x-protobuf",
          "Content-Length": data.byteLength,
        },
      };
      const lib = url.protocol === "https:" ? https : http;

      let settled = false;
      let req: http.ClientRequest | undefined;
      const finish = (result: AttemptResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (req) this._activeRequests.delete(req);
        resolve(result);
      };
      const timer = setTimeout(() => {
        finish({ body: "", error: new Error(`timed out after ${timeoutMs} ms`) });
        req?.destroy();
      }, timeoutMs);

      try {
        req = lib.request(options, (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          res.on("data", (chunk: Buffer) => {
            if (received < MAX_RESPONSE_BODY_BYTES) {
              chunks.push(chunk.subarray(0, MAX_RESPONSE_BODY_BYTES - received));
            }
            received += chunk.length;
          });
          const done = () =>
            finish({
              statusCode: res.statusCode,
              statusMessage: res.statusMessage,
              body: Buffer.concat(chunks).toString("utf8"),
              retryAfterMs: parseRetryAfter(res.headers["retry-after"]),
            });
          res.on("end", done);
          // A response cut off mid-body emits neither 'end' nor a request error.
          res.on("error", (err) => finish({ body: "", error: err }));
          res.on("close", () => (res.complete ? done() : finish({ body: "", error: new Error("response closed before it completed") })));
        });
        this._activeRequests.add(req);
        req.on("error", (err) => finish({ body: "", error: err }));
        req.write(data);
        req.end();
      } catch (err) {
        finish({ body: "", error: err instanceof Error ? err : new Error(String(err)) });
      }
    });
  }

  /**
   * Abort every export still in flight or queued, keeping the exporter
   * usable. `Netra.shutdown()` calls this when its flush budget runs out, so
   * an upload to a hung endpoint cannot keep a finished process alive
   * (JS-PERF-003).
   */
  abortPending(): void {
    this._abortEpoch++;
    for (const wake of [...this._sleepers]) wake();
    for (const req of [...this._activeRequests]) req.destroy();
    this._activeRequests.clear();
    // Queued batches start, see the new epoch and fail at once.
    const queued = this._queue.splice(0);
    for (const start of queued) start();
  }

  /** Waits for in-flight exports; each is bounded by its deadline. */
  async forceFlush(): Promise<void> {
    await Promise.allSettled([...this._inFlight]);
  }

  /**
   * Stops new exports and aborts in-flight requests, so an open socket to a
   * hung endpoint cannot keep the process alive after shutdown (JS-PERF-003).
   */
  async shutdown(): Promise<void> {
    this._isShutdown = true;
    // Queued batches start, see the shutdown flag and fail at once.
    while (this._queue.length) this._queue.shift()!();
    for (const wake of [...this._sleepers]) wake();
    for (const req of this._activeRequests) req.destroy();
    this._activeRequests.clear();
    await Promise.allSettled([...this._inFlight]);
  }
}
