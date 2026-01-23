import { SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode } from "@opentelemetry/core";

import { setTrialBlocked } from "./utils";

export class TrialAwareOTLPExporter implements SpanExporter {
  constructor(private readonly exporter: SpanExporter) {
    this.setupInterception();
  }

  private setupInterception() {
    const anyExporter = this.exporter as any;
    const session = anyExporter?._session;

    if (!session?.request) return;

    const originalRequest = session.request.bind(session);
    session.request = async (...args: any[]) => {
      const response = await originalRequest(...args);
      this.checkResponse(response);
      return response;
    };
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: ExportResultCode }) => void,
  ): void {
    try {
      this.exporter.export(spans, resultCallback);
    } catch {
      resultCallback({ code: ExportResultCode.FAILED });
    }
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() || Promise.resolve();
  }

  private async checkResponse(response: any) {
    try {
      const body = await response?.json?.();
      const errorCode = body?.error?.error?.code;
      if (errorCode === "QUOTA_EXCEEDED") {
        setTrialBlocked(true);
      }
    } catch {
      /* ignore */
    }
  }
}
