import * as http from "http";
import * as https from "https";
import { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ExportResult, ExportResultCode } from "@opentelemetry/core";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { isTrialBlocked, setTrialBlocked } from "./utils";

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
      const serialized = JsonTraceSerializer.serializeRequest(spans);
      if (!serialized) throw new Error("Serialization failed");
      data = serialized;
    } catch (err) {
      return resultCallback({
        code: ExportResultCode.FAILED,
        error: err instanceof Error ? err : new Error("Serialization failed"),
      });
    }

    const url = new URL(this._url);
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        ...this._headers,
        host: url.host,
        "Content-Type": "application/json",
        "Content-Length":
          typeof data === "string" ? Buffer.byteLength(data) : data.byteLength,
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
          this.checkErrorBody(body, res.statusCode);
          resultCallback({
            code: ExportResultCode.FAILED,
            error: new Error(`Status ${res.statusCode}`),
          });
        }
      });
    });

    req.on("error", (err) =>
      resultCallback({ code: ExportResultCode.FAILED, error: err }),
    );
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
