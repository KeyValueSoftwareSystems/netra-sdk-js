/**
 * Serialization Span Processor
 *
 * Single enforcement point for attribute serialization and truncation.
 * Wraps span.setAttribute in onStart so every value is serialized and
 * truncated at write time. Uses jsonrepair-based truncation for JSON
 * values and `...[TRUNCATED]` suffix for plain strings, aligned with
 * backend behavior.
 *
 * MUST be registered FIRST among setAttribute-wrapping processors so
 * it forms the innermost layer (closest to OTel original). This ensures
 * all values — including those assembled by SpanIOProcessor — pass
 * through truncation before reaching the underlying span storage.
 */

import { AttributeValue, Context, Span } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { serializeAttribute } from "../utils/serialization/truncating-serializer";
import { Config } from "../config";
import { Logger } from "../logger";

type SetAttributeFn = (key: string, value: AttributeValue) => Span;

export class SerializationSpanProcessor implements SpanProcessor {
  private readonly maxAttributeSize: number;

  constructor(maxAttributeSize?: number) {
    this.maxAttributeSize = maxAttributeSize ?? Config.SPAN_ATTRIBUTE_MAX_SIZE;
  }

  onStart(span: Span, _parentContext: Context): void {
    try {
      this.wrapSetAttribute(span);
    } catch (e) {
      Logger.debug("SerializationSpanProcessor.onStart error:", e);
    }
  }

  onEnd(_span: ReadableSpan): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  private wrapSetAttribute(span: Span): void {
    const original: SetAttributeFn = span.setAttribute.bind(span);
    const maxSize = this.maxAttributeSize;

    const patched = (key: string, value: AttributeValue): Span => {
      try {
        const truncated = serializeAttribute(value, maxSize);
        return original(key, truncated as AttributeValue);
      } catch {
        try {
          return original(key, value);
        } catch {
          return span;
        }
      }
    };

    (span as any).setAttribute = patched;
  }
}
