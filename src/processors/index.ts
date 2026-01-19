/**
 * Span Processors for Netra SDK
 * 
 * These processors enhance spans with additional context and handle
 * attribute management, session tracking, and sensitive data scrubbing.
 */

export { SessionSpanProcessor } from "./session-span-processor";
export { InstrumentationSpanProcessor } from "./instrumentation-span-processor";
export { ScrubbingSpanProcessor } from "./scrubbing-span-processor";
