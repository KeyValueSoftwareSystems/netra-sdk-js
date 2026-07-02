/**
 * Attribute Size Limit Span Processor
 *
 * Enforces a hard max length on every span attribute value via setAttribute
 * wrapping in onStart. Prevents "entity too large" errors during export.
 */

import { AttributeValue, Context, Span } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Logger } from "../logger";

const DEFAULT_MAX_ATTRIBUTE_SIZE = 32_000; // 32KB per attribute

type SetAttributeFn = (key: string, value: AttributeValue) => Span;

export class AttributeSizeLimitProcessor implements SpanProcessor {
  private maxAttributeSize: number;

  constructor(maxAttributeSize?: number) {
    this.maxAttributeSize = maxAttributeSize ?? DEFAULT_MAX_ATTRIBUTE_SIZE;
  }

  onStart(span: Span, _parentContext: Context): void {
    try {
      this._wrapSetAttribute(span);
    } catch (e) {
      Logger.debug("AttributeSizeLimitProcessor.onStart error:", e);
    }
  }

  onEnd(_span: ReadableSpan): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  private _wrapSetAttribute(span: Span): void {
    const original: SetAttributeFn = span.setAttribute.bind(span);
    const maxLen = this.maxAttributeSize;

    const patched = (key: string, value: AttributeValue): Span => {
      try {
        return original(key, truncateValue(value, maxLen) as AttributeValue);
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

function truncateValue(value: unknown, maxLen: number): unknown {
  if (typeof value === "string") {
    return value.length > maxLen ? value.substring(0, maxLen) : value;
  }

  if (Array.isArray(value)) {
    const serialized = JSON.stringify(value);
    if (serialized.length > maxLen) {
      return serialized.substring(0, maxLen);
    }
    return value;
  }

  return value;
}
