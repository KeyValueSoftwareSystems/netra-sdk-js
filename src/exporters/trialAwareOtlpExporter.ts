import * as http from "http";
import * as https from "https";
import { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ExportResult, ExportResultCode } from "@opentelemetry/core";
import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import { Logger } from "../logger";
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
function describeServerMessage(responseBody: string): string {
  try {
    const parsed: unknown = JSON.parse(responseBody);
    const message = (parsed as { error?: { message?: unknown } } | null)?.error
      ?.message;
    if (typeof message === "string") return `"${message}"`;
    if (Array.isArray(message) && message.every((m) => typeof m === "string")) {
      return `"${message.join("; ")}"`;
    }
  } catch {
    // Not JSON: quote the raw body below.
  }
  const excerpt = responseBody.trim().slice(0, RESPONSE_EXCERPT_MAX_CHARS);
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
  const status = [statusCode ?? "unknown", statusMessage]
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
}

export class TrialAwareOTLPExporter implements SpanExporter {
  private _url: string;
  private _headers: Record<string, string>;
  private _isShutdown = false;

  constructor(config: ExporterConfig) {
    this._url = config.url;
    this._headers = config.headers || {};
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    if (this._isShutdown || isTrialBlocked()) {
      return resultCallback({ code: ExportResultCode.SUCCESS });
    }

    let data: Uint8Array | string;
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

    const requestBytes =
      typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    const url = new URL(this._url);
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        ...this._headers,
        host: url.host,
        "Content-Type": "application/x-protobuf",
        "Content-Length": requestBytes,
      },
    };

    const lib = url.protocol === "https:" ? https : http;

    const req = lib.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resultCallback({ code: ExportResultCode.SUCCESS });
        } else {
          // Debug mode only (Logger.warn). The batch is not retried, so it is gone.
          Logger.warn(
            formatExportFailure(
              res.statusCode,
              res.statusMessage,
              body,
              spans.length,
              requestBytes,
            ),
          );
          this.checkErrorBody(body, res.statusCode);
          resultCallback({
            code: ExportResultCode.FAILED,
            error: new Error(`Status ${res.statusCode}`),
          });
        }
      });
    });

    req.on("error", (err) => {
      // No response (connection refused, DNS, TLS, socket reset): nothing else logs this.
      Logger.warn(
        `Span export failed: ${err.message}. ` +
          `Dropped a batch of ${spans.length} spans (${requestBytes} bytes).`,
      );
      resultCallback({ code: ExportResultCode.FAILED, error: err });
    });
    req.write(data);
    req.end();
  }

  private checkErrorBody(bodyString: string, statusCode?: number) {
    try {
      const jsonBody = JSON.parse(bodyString);
      const errorCode = jsonBody?.error?.code || statusCode;
      const errorMessage = jsonBody?.error?.message || "";

      if (errorCode === 429 || errorMessage.includes("usage quota exceeded")) {
        setTrialBlocked(true);
      }
    } catch (e) {
      if (statusCode === 429 || bodyString.includes("quota exceeded")) {
        setTrialBlocked(true);
      }
    }
  }

  async forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  async shutdown(): Promise<void> {
    this._isShutdown = true;
    return Promise.resolve();
  }
}
