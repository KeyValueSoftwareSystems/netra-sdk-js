/**
 * Scrubbing Span Processor
 *
 * OpenTelemetry span processor that scrubs sensitive data from span attributes.
 * This includes API keys, emails, phone numbers, SSNs, credit cards, passwords,
 * bearer tokens, and other sensitive information.
 */

import { Context, Span } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Logger } from "../logger";

// Sensitive patterns for data detection (based on pydantic logfire scrubbing)
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

export class ScrubbingSpanProcessor implements SpanProcessor {
  /**
   * Check if a key is considered sensitive.
   */
  private isSensitiveKey(key: string): boolean {
    const keyLower = key.toLowerCase();
    for (const sensitiveKey of SENSITIVE_KEYS) {
      if (keyLower.includes(sensitiveKey)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Scrub sensitive patterns from a string value.
   */
  private scrubStringValue(value: string): string {
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

  /**
   * Recursively scrub sensitive data from a dictionary value.
   */
  private scrubDictValue(
    value: Record<string, unknown>,
  ): Record<string, unknown> {
    const scrubbed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const [, scrubbedValue] = this.scrubKeyValue(k, v);
      scrubbed[k] = scrubbedValue;
    }
    return scrubbed;
  }

  /**
   * Recursively scrub sensitive data from a list value.
   */
  private scrubListValue(value: unknown[]): unknown[] {
    return value.map((item) => {
      if (typeof item === "string") {
        return this.scrubStringValue(item);
      } else if (Array.isArray(item)) {
        return this.scrubListValue(item);
      } else if (typeof item === "object" && item !== null) {
        return this.scrubDictValue(item as Record<string, unknown>);
      }
      return item;
    });
  }

  /**
   * Scrub sensitive data from a key-value pair.
   */
  private scrubKeyValue(key: string, value: unknown): [string, unknown] {
    // Check if key itself is sensitive and value is a simple type
    if (
      this.isSensitiveKey(key) &&
      typeof value !== "object" &&
      !Array.isArray(value)
    ) {
      return [key, SCRUB_REPLACEMENT];
    }

    // Scrub value based on its type
    if (typeof value === "string") {
      return [key, this.scrubStringValue(value)];
    } else if (Array.isArray(value)) {
      return [key, this.scrubListValue(value)];
    } else if (typeof value === "object" && value !== null) {
      return [key, this.scrubDictValue(value as Record<string, unknown>)];
    }

    return [key, value];
  }

  /**
   * Called when a span starts. No-op for this processor.
   */
  onStart(span: Span, parentContext: Context): void {
    // No-op - scrubbing happens on span end
  }

  /**
   * Called when a span ends. Scrubs sensitive data from span attributes.
   */
  onEnd(span: ReadableSpan): void {
    try {
      // Get span attributes - we need to access the internal attributes
      const spanAny = span as any;
      const attributes = spanAny.attributes || spanAny._attributes;

      if (attributes && typeof attributes === "object") {
        const scrubbedAttributes: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(attributes)) {
          const [, scrubbedValue] = this.scrubKeyValue(key, value);
          scrubbedAttributes[key] = scrubbedValue;
        }

        // Replace attributes with scrubbed versions
        // This works because ReadableSpan is actually a reference to the span object
        if (spanAny._attributes) {
          spanAny._attributes = scrubbedAttributes;
        } else if (spanAny.attributes) {
          // Some implementations use different property names
          Object.keys(spanAny.attributes).forEach(
            (k) => delete spanAny.attributes[k],
          );
          Object.assign(spanAny.attributes, scrubbedAttributes);
        }
      }
    } catch (e) {
      Logger.error("ScrubbingSpanProcessor: Error scrubbing attributes:", e);
    }
  }

  /**
   * Shuts down the processor.
   */
  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Forces a flush of any pending spans.
   */
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
