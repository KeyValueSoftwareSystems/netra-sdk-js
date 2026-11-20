/**
 * Scrubbing Span Processor
 *
 * OpenTelemetry span processor that scrubs sensitive data from span attributes
 * at write time via setAttribute wrapping. This includes API keys, emails,
 * phone numbers, SSNs, credit cards, passwords, bearer tokens, and other
 * sensitive information.
 *
 * Handles both pre-serialized string values (the normal path when
 * SerializationSpanProcessor is active) and raw objects/arrays (defensive
 * fallback for custom pipelines that skip serialization).
 *
 * Wraps in onStart to avoid unreliable _attributes mutation in onEnd.
 * MUST be registered BEFORE SerializationSpanProcessor so it forms the
 * innermost layer (closest to OTel storage). Because serialization wraps
 * outside this layer, values are serialized to strings first, then this
 * processor scrubs sensitive patterns from the resulting string values.
 */

import { AttributeValue, Context, Span } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NetraLogger } from "../netraLogger";

// Sensitive patterns for data detection
const SENSITIVE_PATTERNS: Record<string, RegExp> = {
  // API keys - scrub "Token: <value>" or sk-... tokens
  api_key: new RegExp(
    "(?:Token:\\s*\\S{32,})" + // Token: <32+ chars>
      "|(?:sk-[A-Za-z0-9]{16,})", // sk-... tokens
    "g",
  ),
  // Email addresses. Every repeat is bounded and the domain is matched label
  // by label, so input like "a.a.a.…" cannot backtrack quadratically (JS-SEC-009).
  email: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}/g,
  // Phone numbers (US format)
  phone: /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,
  // Credit cards (Visa, Mastercard, Amex, Discover)
  credit_card:
    /(?<!\d)(?:4\d{15}|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d{2})\d{12})(?!\d)/g,
  // Social Security Numbers
  ssn: /\b\d{3}-?\d{2}-?\d{4}\b/g,
  // Password patterns
  password: /(?:password|passwd|pwd|secret|token)\s*[:=]\s*\S+/gi,
  // Bearer tokens
  bearer_token: /(?:authorization:\s*)?bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // Authorization headers
  authorization: /authorization\s*:\s*\S+/gi,
};

// Generic pattern for long digit sequences (credit/debit cards)
const LONG_DIGIT_PATTERN = /(?<!\d)\d{13,19}(?!\d)/g;

// Attribute-name parts whose values are scrubbed. Matched against whole parts
// of the name (split on non-alphanumerics), not as substrings: substring
// matching on "key" and "span" also scrubbed keys such as `netra.span.type`
// (JS-SEC-021).
const SENSITIVE_KEY_PARTS = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "auth",
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "cookie",
]);

// Multi-part sensitive names, matched as whole parts with any separator.
const SENSITIVE_KEY_PHRASES =
  /(?:^|[^a-z0-9])(?:api[-_]?key|apikey|private[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token|id[-_]?token|x[-_]api[-_]key|x[-_]auth[-_]token|set[-_]cookie|client[-_]?secret)(?:$|[^a-z0-9])/;

const SCRUB_REPLACEMENT = "[SCRUBBED]";

type SetAttributeFn = (key: string, value: AttributeValue) => Span;

export function isSensitiveKey(key: string): boolean {
  const keyLower = key.toLowerCase();
  if (SENSITIVE_KEY_PHRASES.test(keyLower)) return true;
  return keyLower.split(/[^a-z0-9]+/).some((part) => SENSITIVE_KEY_PARTS.has(part));
}

function scrubStringValue(value: string): string {
  let scrubbed = value;

  // Early catch-all for contiguous 13-19 digit sequences (credit/debit cards)
  scrubbed = scrubbed.replace(LONG_DIGIT_PATTERN, SCRUB_REPLACEMENT);

  // Apply all sensitive patterns (one replace pass each; a separate test()
  // pass doubled the work)
  for (const pattern of Object.values(SENSITIVE_PATTERNS)) {
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, SCRUB_REPLACEMENT);
  }

  return scrubbed;
}

function scrubDict(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = scrubAny(k, v);
  }
  return result;
}

function scrubList(arr: unknown[]): unknown[] {
  return arr.map((item) => {
    if (typeof item === "string") return scrubStringValue(item);
    if (Array.isArray(item)) return scrubList(item);
    if (typeof item === "object" && item !== null) {
      return scrubDict(item as Record<string, unknown>);
    }
    return item;
  });
}

function scrubAny(key: string, value: unknown): unknown {
  if (isSensitiveKey(key) && typeof value !== "object" && !Array.isArray(value)) {
    return SCRUB_REPLACEMENT;
  }
  if (typeof value === "string") return scrubStringValue(value);
  if (Array.isArray(value)) return scrubList(value);
  if (typeof value === "object" && value !== null) {
    return scrubDict(value as Record<string, unknown>);
  }
  return value;
}

function scrubValue(key: string, value: AttributeValue): AttributeValue {
  return scrubAny(key, value) as AttributeValue;
}

function scrubAttributes(attrs: unknown): unknown {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return attrs;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
    out[k] = v === undefined ? v : scrubValue(k, v as AttributeValue);
  }
  return out;
}

export class ScrubbingSpanProcessor implements SpanProcessor {
  onStart(span: Span, _parentContext: Context): void {
    try {
      this.wrapSetAttribute(span);
      this.wrapOtherWriters(span);
      this.scrubInitialState(span);
    } catch (e) {
      NetraLogger.error("ScrubbingSpanProcessor.onStart error:", e);
    }
  }

  /**
   * Attributes passed to startSpan() and the span name are set before
   * onStart, so the setAttribute wrapper never saw them (JS-SEC-021).
   */
  private scrubInitialState(span: Span): void {
    const attrs = (span as any).attributes;
    if (attrs && typeof attrs === "object") {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined) continue;
        const scrubbed = scrubValue(k, v as AttributeValue);
        if (scrubbed !== v) span.setAttribute(k, scrubbed);
      }
    }
    const name = (span as any).name;
    if (typeof name === "string") {
      const scrubbedName = scrubStringValue(name);
      if (scrubbedName !== name) span.updateName(scrubbedName);
    }
  }

  /**
   * Events (including the exception event recordException adds), status
   * messages and renamed spans are scrubbed too (JS-SEC-021).
   */
  private wrapOtherWriters(span: Span): void {
    const s = span as any;
    const addEvent = s.addEvent?.bind(span);
    if (addEvent) {
      s.addEvent = (name: string, attributesOrTime?: unknown, time?: unknown) => {
        try {
          return addEvent(name, scrubAttributes(attributesOrTime), time);
        } catch {
          return addEvent(name, attributesOrTime, time);
        }
      };
    }
    const setStatus = s.setStatus?.bind(span);
    if (setStatus) {
      s.setStatus = (status: { code: number; message?: string }) =>
        setStatus(
          status && typeof status.message === "string"
            ? { ...status, message: scrubStringValue(status.message) }
            : status,
        );
    }
    const updateName = s.updateName?.bind(span);
    if (updateName) {
      s.updateName = (name: string) => updateName(typeof name === "string" ? scrubStringValue(name) : name);
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

    const patched = (key: string, value: AttributeValue): Span => {
      try {
        return original(key, scrubValue(key, value));
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
