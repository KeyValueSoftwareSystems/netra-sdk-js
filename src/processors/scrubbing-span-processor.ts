/**
 * Scrubbing Span Processor
 *
 * OpenTelemetry span processor that scrubs sensitive data from span attributes
 * at write time via setAttribute wrapping. This includes API keys, emails,
 * phone numbers, SSNs, credit cards, passwords, bearer tokens, and other
 * sensitive information.
 *
 * Wraps in onStart to avoid unreliable _attributes mutation in onEnd.
 * MUST be registered AFTER SerializationSpanProcessor so scrubbing operates
 * on already-serialized string values.
 */

import { AttributeValue, Context, Span } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Logger } from "../logger";

// Sensitive patterns for data detection
const SENSITIVE_PATTERNS: Record<string, RegExp> = {
  // API keys - scrub "Token: <value>" or sk-... tokens
  api_key: new RegExp(
    "(?:Token:\\s*\\S{32,})" + // Token: <32+ chars>
      "|(?:sk-[A-Za-z0-9]{16,})", // sk-... tokens
    "g",
  ),
  // Email addresses
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi,
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

// Sensitive attribute keys that should have their values scrubbed
const SENSITIVE_KEYS = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "key",
  "api_key",
  "auth",
  "authorization",
  "bearer",
  "credential",
  "private_key",
  "access_token",
  "refresh_token",
  "session_token",
  "x-api-key",
  "x-auth-token",
  "cookie",
  "set-cookie",
  "span",
]);

const SCRUB_REPLACEMENT = "[SCRUBBED]";

type SetAttributeFn = (key: string, value: AttributeValue) => Span;

function isSensitiveKey(key: string): boolean {
  const keyLower = key.toLowerCase();
  for (const sensitiveKey of SENSITIVE_KEYS) {
    if (keyLower.includes(sensitiveKey)) {
      return true;
    }
  }
  return false;
}

function scrubStringValue(value: string): string {
  let scrubbed = value;

  // Early catch-all for contiguous 13-19 digit sequences (credit/debit cards)
  scrubbed = scrubbed.replace(LONG_DIGIT_PATTERN, SCRUB_REPLACEMENT);

  // Apply all sensitive patterns
  for (const pattern of Object.values(SENSITIVE_PATTERNS)) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    if (pattern.test(scrubbed)) {
      pattern.lastIndex = 0;
      scrubbed = scrubbed.replace(pattern, SCRUB_REPLACEMENT);
    }
  }

  return scrubbed;
}

function scrubValue(key: string, value: AttributeValue): AttributeValue {
  if (
    isSensitiveKey(key) &&
    typeof value !== "object" &&
    !Array.isArray(value)
  ) {
    return SCRUB_REPLACEMENT;
  }

  if (typeof value === "string") {
    return scrubStringValue(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === "string" ? scrubStringValue(item) : item,
    ) as AttributeValue;
  }

  return value;
}

export class ScrubbingSpanProcessor implements SpanProcessor {
  onStart(span: Span, _parentContext: Context): void {
    try {
      this.wrapSetAttribute(span);
    } catch (e) {
      Logger.error("ScrubbingSpanProcessor.onStart error:", e);
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
