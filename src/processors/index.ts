/**
 * Span Processors for Netra SDK
 *
 * These processors enhance spans with additional context and handle
 * attribute management, session tracking, and sensitive data scrubbing.
 */

export { InstrumentationSpanProcessor } from "./instrumentation-span-processor";
export { LlmTraceIdentifierSpanProcessor } from "./llm-trace-identifier-span-processor";
export { withBlockedSpansLocal } from "./localfiltering-span-processor";
export { RootSpanProcessor } from "./root-span-processor";
export { ScrubbingSpanProcessor } from "./scrubbing-span-processor";
export {
  SessionSpanProcessor,
  setSessionBaggage,
} from "./session-span-processor";
