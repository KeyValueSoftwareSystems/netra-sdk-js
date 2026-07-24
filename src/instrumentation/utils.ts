/**
 * Shared utility functions for instrumentation.
 * Handles setting OTel span attributes for LLM request/response tracing.
 */

import {
  Span,
  context,
  type Context as OTelContext,
  type HrTime,
} from "@opentelemetry/api";
import { hrTimeToMilliseconds } from "@opentelemetry/core";
import { Logger } from "../logger";
import { RootSpanProcessor } from "../processors/root-span-processor";
import { safeStringify } from "../utils/serialization";
import { SpanAttributes } from "./span-attributes";

/**
 * Controls where native traces are sent.
 *
 * - `"netra"` -- Replace the SDK's default processors so traces go
 *   only to Netra. If the SDK does not expose the required APIs, falls back
 *   to additive mode (both Netra and native) and logs a warning.
 * - `"netra-strict"` (default) -- Same replacement as `"netra"`, but if the SDK APIs
 *   are unavailable the processor is **not** registered at all, ensuring
 *   traces never reach native even at the cost of no tracing.
 * - `"both"` -- The Netra processor is added alongside the native defaults;
 *   traces go to both Netra and native.
 *
 * Can also be set via the `NATIVE_TRACING_MODE` environment
 * variable using the same string values.
 */
export type NativeTracingMode = "both" | "netra" | "netra-strict";

const VALID_NATIVE_TRACING_MODES = new Set<string>(["both", "netra", "netra-strict"]);

export function parseNativeTracingEnv(name: string): NativeTracingMode | undefined {
  const val = process.env[name];
  if (val === undefined || val === "") return undefined;
  if (VALID_NATIVE_TRACING_MODES.has(val)) return val as NativeTracingMode;
  return undefined;
}

// Suppression
const SUPPRESS_INSTRUMENTATION_KEY = Symbol("netra.suppress_instrumentation");

export function shouldSuppressInstrumentation(): boolean {
  const ctx = context.active();
  return ctx.getValue(SUPPRESS_INSTRUMENTATION_KEY) === true;
}

/**
 * Return a new context derived from `ctx` (default: active) with
 * Netra instrumentation suppressed.  Wrappers that call the original
 * method within this context prevent nested google_genai spans (e.g.
 * Chat.sendMessage → generateContentInternal).
 */
export function createSuppressedContext(ctx?: OTelContext): OTelContext {
  return (ctx ?? context.active()).setValue(SUPPRESS_INSTRUMENTATION_KEY, true);
}

// Type Utilities — re-export from canonical location to avoid duplication
export { isPromise } from "../utils/response-handler";

/**
 * Define a non-enumerable, writable, configurable property on `target`.
 * Used to hide OTel internals (spans, contexts) from JSON.stringify
 * while keeping them accessible to instance methods.
 */
export function defineHidden<T>(target: object, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

export function isDict(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function modelAsDict(obj: unknown): Record<string, unknown> {
  if (obj == null || typeof obj !== "object") return {};

  if (
    "toJSON" in obj &&
    typeof (obj as { toJSON?: unknown }).toJSON === "function"
  ) {
    return (obj as { toJSON: () => unknown }).toJSON() as Record<
      string,
      unknown
    >;
  }

  if (Object.getPrototypeOf(obj) === Object.prototype) {
    return { ...(obj as Record<string, unknown>) };
  }

  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return {};
  }
}

/**
 * A normalized input or output message used for span attribute recording.
 * Providers can build TracedMessage[] using their own extraction logic and
 * pass it directly to writePromptAttributes / writeCompletionAttributes.
 */
export interface TracedMessage {
  role: string;
  content: string;
}

export function isTraceContentEnabled(): boolean {
  const raw =
    process.env.TRACELOOP_TRACE_CONTENT ??
    process.env.NETRA_TRACE_CONTENT ??
    "";
  return ["1", "true"].includes(String(raw).toLowerCase());
}

/**
 * Returns true if `value` represents meaningful content worth recording.
 * Guards against setting empty-string attributes on spans.
 */
export function hasContent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

// First-token timing

/**
 * Spans whose first-token timing has already been dealt with -- either recorded
 * or deliberately skipped. Membership is what makes `recordFirstTokenTiming`
 * idempotent, and it covers the skip cases too so that a span we cannot measure
 * is examined (and logged about) once, rather than once per chunk for the whole
 * life of a stream.
 */
const firstTokenHandledSpans = new WeakSet<Span>();

/**
 * Provider request types this SDK instruments, declared as one union rather
 * than per provider so that `TOKENLESS_REQUEST_TYPES` is checked against it.
 * A provider that starts instrumenting a new operation fails to compile at its
 * `recordFirstTokenTiming` call until someone widens this union, which forces
 * the question of whether that operation generates tokens.
 */
export type LlmRequestType =
  | "agent"
  | "batches"
  | "beta"
  | "chat"
  | "embedding"
  | "fim"
  | "response";

/**
 * Request types whose spans complete without generating any tokens, so a
 * time-to-first-token measurement would be meaningless on them. Keeping the
 * rule here rather than at each call site keeps every provider consistent.
 */
const TOKENLESS_REQUEST_TYPES = new Set<LlmRequestType>([
  "batches",
  "embedding",
]);

/**
 * Fields a streaming chat delta may carry that represent generated output.
 * `content` alone is not enough: a tool-calling turn streams tool-call deltas
 * with a null `content`, and would otherwise never record a first token.
 * Both casings are listed because Mistral's SDK camelCases delta fields while
 * the OpenAI-compatible providers use snake_case. Reasoning models are listed
 * under both `reasoning` and `reasoning_content` because OpenAI-compatible
 * gateways disagree on which one carries the thinking stream, and on a
 * reasoning turn it precedes visible `content` by seconds.
 */
const CONTENT_BEARING_DELTA_FIELDS = [
  "content",
  "tool_calls",
  "toolCalls",
  "function_call",
  "functionCall",
  "refusal",
  "reasoning",
  "reasoning_content",
  "audio",
] as const;

/** True if a streaming chat delta carries generated output of any kind. */
function hasGeneratedContent(delta: unknown): boolean {
  if (!isDict(delta)) return false;
  return CONTENT_BEARING_DELTA_FIELDS.some((field) => hasContent(delta[field]));
}

function spanStartMs(span: Span): number | undefined {
  // `startTime` exists on SDK spans but not on the api-level Span interface.
  const startTime = (span as unknown as { startTime?: HrTime }).startTime;
  if (!Array.isArray(startTime)) return undefined;
  const startMs = hrTimeToMilliseconds(startTime);
  return Number.isFinite(startMs) ? startMs : undefined;
}

/**
 * Elapsed seconds between two wall-clock readings, or `undefined` when the
 * pair does not yield a usable duration.
 *
 * A backward clock step (NTP correction, host suspend) between the span
 * starting and the first token arriving yields a negative duration. Clamping
 * that to zero would only swap one corrupt value for another: a zero-second
 * time-to-first-token is indistinguishable from a real measurement, so it
 * silently drags down every average and histogram bucket it lands in.
 * Returning `undefined` leaves the attribute off the span instead, which
 * downstream can at least see and account for.
 */
function elapsedSeconds(
  eventMs: number,
  startMs: number,
): number | undefined {
  const seconds = (eventMs - startMs) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export interface FirstTokenTimingOptions {
  /**
   * Whether the value being recorded came from a streamed response. Stamped
   * onto the span so consumers never have to infer the call shape.
   */
  streaming: boolean;
  /**
   * Provider request type, when the call site has one. Spans for token-less
   * operations (embeddings, batch submission) are skipped.
   */
  requestType?: LlmRequestType;
}

/**
 * Record time-to-first-token on an LLM span, measured at the moment of the call.
 *
 * Sets:
 *   - `gen_ai.performance.time_to_first_token` -- seconds since this span started.
 *   - `gen_ai.performance.time_to_first_token.timestamp` -- UTC ISO-8601 instant.
 *   - `gen_ai.performance.time_to_first_token.streaming` -- whether the value
 *     came from a streamed response (see below).
 *   - `gen_ai.performance.relative_time_to_first_token` -- seconds since the
 *     trace's root span started, so first-token latency of the individual LLM
 *     calls of one request can be placed on a shared timeline.
 *
 * On a non-streaming call the first token is not observable before the whole
 * response is, so the recorded value necessarily equals total request latency.
 * Folding those into a streaming first-token aggregate inflates it by the full
 * generation time of every non-streaming call, so the call shape is stamped on
 * the span itself. Do not use `llm.is_streaming` to make that split: it is
 * absent rather than `false` on non-streaming spans, Anthropic's `.stream()`
 * helper reports `llm.streaming` instead, and the google-generative-ai stream
 * wrapper sets neither.
 *
 * `relative_time_to_first_token` is omitted whenever no root span is registered
 * for the trace. Note that `RootSpanProcessor` only registers spans with no
 * parent *in this process*, so a service handling a request that arrived with a
 * `traceparent` header has no local root and emits no relative timing for any of
 * its spans. Absolute `time_to_first_token` is still emitted.
 *
 * Call this on the first content-bearing chunk when streaming -- or use
 * `recordFirstTokenFromDelta`, which makes that check -- and as soon as the
 * response resolves when not. Only the first call per span takes effect, so
 * streaming call sites need no first-chunk bookkeeping of their own.
 *
 * Never throws. This runs on every chunk of every stream, and in several
 * providers the enclosing iterator rethrows to the host application, so an
 * instrumentation failure here would otherwise abort the caller's stream.
 */
export function recordFirstTokenTiming(
  span: Span,
  opts: FirstTokenTimingOptions,
): void {
  try {
    if (firstTokenHandledSpans.has(span) || !span.isRecording()) return;

    if (
      opts.requestType !== undefined &&
      TOKENLESS_REQUEST_TYPES.has(opts.requestType)
    ) {
      firstTokenHandledSpans.add(span);
      return;
    }

    // `Date.now()` and not the monotonic clock: `@opentelemetry/sdk-trace-base`
    // derives `Span.startTime` from `Date.now()`, and subtracting a monotonic
    // reading from a wall-clock one biases the result by however far the two
    // have diverged -- far enough to go negative after a host suspend or an
    // NTP step.
    const eventMs = Date.now();
    const spanStart = spanStartMs(span);
    if (spanStart === undefined) {
      firstTokenHandledSpans.add(span);
      Logger.debug(
        "netra.instrumentation: no readable startTime on span," +
          " skipping time-to-first-token",
      );
      return;
    }

    const timeToFirstToken = elapsedSeconds(eventMs, spanStart);
    if (timeToFirstToken === undefined) {
      firstTokenHandledSpans.add(span);
      Logger.debug(
        "netra.instrumentation: span start is after its first token" +
          " (clock step), skipping time-to-first-token",
      );
      return;
    }

    firstTokenHandledSpans.add(span);
    span.setAttribute(
      SpanAttributes.LLM_TIME_TO_FIRST_TOKEN,
      timeToFirstToken,
    );
    span.setAttribute(
      SpanAttributes.LLM_TIME_TO_FIRST_TOKEN_TIMESTAMP,
      new Date(eventMs).toISOString(),
    );
    span.setAttribute(
      SpanAttributes.LLM_TIME_TO_FIRST_TOKEN_STREAMING,
      opts.streaming,
    );

    const rootSpan = RootSpanProcessor.getRootSpan(span);
    const rootStart = rootSpan ? spanStartMs(rootSpan) : undefined;
    if (rootStart === undefined) return;

    const relative = elapsedSeconds(eventMs, rootStart);
    if (relative === undefined) return;

    span.setAttribute(
      SpanAttributes.LLM_RELATIVE_TIME_TO_FIRST_TOKEN,
      relative,
    );
  } catch (e) {
    Logger.error(
      "netra.instrumentation: time-to-first-token recording failed",
      e,
    );
  }
}

/**
 * Record first-token timing from a streaming chat delta, when that delta is the
 * first one carrying generated output.
 *
 * Consults the already-handled set before inspecting the delta, so the field
 * scan runs only up to the first token rather than on every chunk of the
 * stream.
 */
export function recordFirstTokenFromDelta(span: Span, delta: unknown): void {
  if (firstTokenHandledSpans.has(span)) return;
  if (!hasGeneratedContent(delta)) return;
  recordFirstTokenTiming(span, { streaming: true });
}

// Attribute Mapping (model params → span attributes)
const PARAM_ATTRIBUTE_MAP: Record<string, string> = {
  model: SpanAttributes.LLM_REQUEST_MODEL,
  temperature: SpanAttributes.LLM_REQUEST_TEMPERATURE,
  max_tokens: SpanAttributes.LLM_REQUEST_MAX_TOKENS,
  max_completion_tokens: SpanAttributes.LLM_REQUEST_MAX_TOKENS,
  max_output_tokens: SpanAttributes.LLM_REQUEST_MAX_TOKENS,
  max_tokens_to_sample: SpanAttributes.LLM_REQUEST_MAX_TOKENS,
  frequency_penalty: SpanAttributes.LLM_FREQUENCY_PENALTY,
  presence_penalty: SpanAttributes.LLM_PRESENCE_PENALTY,
  reasoning_effort: SpanAttributes.LLM_REQUEST_REASONING_EFFORT,
  stop: SpanAttributes.LLM_CHAT_STOP_SEQUENCES,
  stream: SpanAttributes.LLM_IS_STREAMING,
  top_p: SpanAttributes.LLM_REQUEST_TOP_P,
};

function setModelParams(span: Span, kwargs: Record<string, unknown>): void {
  for (const [key, attr] of Object.entries(PARAM_ATTRIBUTE_MAP)) {
    const value = kwargs[key];
    if (value !== undefined) {
      span.setAttribute(attr, value as any);
    }
  }
}

/**
 * Extracts input messages for OpenAI-compatible request shapes:
 *   - "chat": messages[] (standard Chat Completions API)
 *   - "response": instructions + input (Responses API)
 *   - everything else: prompt string or embedding input
 *
 * Google GenAI and other providers with different shapes should build their
 * own TracedMessage[] and call writePromptAttributes directly.
 */
export function buildInputMessages(
  kwargs: Record<string, unknown>,
  requestType: string,
): TracedMessage[] {
  const messages: TracedMessage[] = [];

  if (requestType === "chat" || requestType === "beta") {
    if (hasContent(kwargs.system)) {
      const systemContent =
        typeof kwargs.system === "string"
          ? kwargs.system
          : safeStringify(kwargs.system);
      messages.push({ role: "system", content: systemContent });
    }

    const rawMessages = kwargs.messages;
    if (!Array.isArray(rawMessages)) return messages;
    for (const msg of rawMessages) {
      if (!isDict(msg) || !hasContent(msg.role) || !hasContent(msg.content)) {
        continue;
      }

      if (msg.role !== "user" || !Array.isArray(msg.content)) {
        messages.push({
          role: msg.role,
          content: safeStringify(msg.content),
        });
        continue;
      }

      const isToolResult = (b: unknown): b is Record<string, unknown> =>
        isDict(b) && b.type === "tool_result";

      const userBlocks = msg.content.filter((b) => !isToolResult(b));

      if (userBlocks.length) {
        messages.push({
          role: "user",
          content: safeStringify(userBlocks),
        });
      }

      for (const block of msg.content) {
        if (!isToolResult(block)) continue;

        messages.push({
          role: "tool",
          content: safeStringify({
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error ?? false,
          }),
        });
      }
    }
  } else if (requestType === "response") {
    if (hasContent(kwargs.instructions)) {
      messages.push({ role: "system", content: String(kwargs.instructions) });
    }
    const input = kwargs.input;
    if (typeof input === "string" && input.length > 0) {
      messages.push({ role: "user", content: input });
    } else if (Array.isArray(input)) {
      for (const msg of input) {
        if (!isDict(msg)) continue;
        if (hasContent(msg.role) && hasContent(msg.content)) {
          messages.push({
            role: msg.role,
            content: safeStringify(msg.content),
          });
        }
      }
    }
  } else if (kwargs.prompt !== undefined) {
    // Legacy single-prompt (e.g.,completions)
    const content = String(kwargs.prompt);
    if (content.length > 0) {
      messages.push({ role: "user", content });
    }
  } else {
    // Embeddings / genericinput
    const input = kwargs.input ?? kwargs.inputs;
    if (hasContent(input)) {
      const content = safeStringify(input);
      messages.push({ role: "user", content });
    }
  }

  return messages;
}

/**
 * Extracts output messages for OpenAI-compatible response shapes:
 *   - choices[].message (Chat Completions API) — with optional tool_calls
 *   - output[].content[].text (Responses API)
 *   - content[] text/tool_use blocks (Anthropic-style)
 *   - scalar output_text shorthand
 *
 * Skips messages with empty content to avoid polluting traces.
 */
export function buildOutputMessages(
  response: Record<string, unknown>,
): TracedMessage[] {
  const messages: TracedMessage[] = [];

  // Priority 1: Chat Completions API (choices[]) — mutually exclusive with all others.
  // A response carrying choices[] is definitively a Chat Completions response; stop here.
  if (Array.isArray(response.choices)) {
    for (const choice of response.choices as Array<Record<string, any>>) {
      const msg = choice.message ?? choice.delta;
      if (!msg) continue;

      if (hasContent(msg.role) && hasContent(msg.content)) {
        messages.push({ role: msg.role, content: String(msg.content) });
      }

      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown> | undefined;
          messages.push({
            role: "tool",
            content: JSON.stringify({
              name: fn?.name ?? "",
              arguments: fn?.arguments ?? "",
            }),
          });
        }
      }
    }
    return messages;
  }

  // Priority 2: Responses API — output_text and/or output[].
  // output_text is a scalar shorthand that mirrors the text portions of output[].
  // When both are present, use output_text for text and output[] only for tool calls
  // to avoid duplicating the same text content.
  const hasOutputText =
    typeof response.output_text === "string" && response.output_text.length > 0;
  const hasOutputArray = Array.isArray(response.output);

  if (hasOutputText || hasOutputArray) {
    if (hasOutputText) {
      messages.push({
        role: "assistant",
        content: response.output_text as string,
      });
    }

    if (hasOutputArray) {
      for (const element of response.output as Array<Record<string, unknown>>) {
        if (!Array.isArray(element.content)) continue;
        for (const chunk of element.content as Array<Record<string, unknown>>) {
          // Only include text from output[] when output_text has not already covered it
          if (!hasOutputText && hasContent(chunk.text)) {
            messages.push({ role: "assistant", content: String(chunk.text) });
          }
          // Always capture tool_use blocks — output_text never contains these
          if (
            (chunk as any).type === "tool_use" &&
            (chunk as any).name
          ) {
            messages.push({
              role: "tool",
              content: JSON.stringify({
                name: (chunk as any).name,
                input: (chunk as any).input,
              }),
            });
          }
        }
      }
    }
    return messages;
  }

  // Priority 3: Anthropic-style content[] blocks — only reached when neither
  // Chat Completions nor Responses API fields are present.
  if (Array.isArray(response.content)) {
    for (const block of response.content as Array<any>) {
      if (block.type === "text" && hasContent(block.text)) {
        messages.push({ role: "assistant", content: String(block.text) });
      } else if (block.type === "tool_use" && block.name) {
        messages.push({
          role: "tool",
          content: JSON.stringify({ id: block.id, name: block.name, input: block.input }),
        });
      }
    }
  }

  return messages;
}

/**
 * Writes a TracedMessage[] in two formats:
 *   1. gen_ai.prompt.{i}.role / gen_ai.prompt.{i}.content  (OTel GenAI conventions)
 *   2. "input" JSON blob (Netra dashboard attribute)
 */
export function writePromptAttributes(
  span: Span,
  messages: TracedMessage[],
): void {
  if (messages.length === 0) return;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    span.setAttribute(
      `${SpanAttributes.LLM_PROMPTS}.${i}.role`,
      msg.role,
    );
    span.setAttribute(
      `${SpanAttributes.LLM_PROMPTS}.${i}.content`,
      msg.content,
    );
  }

  span.setAttribute("input", JSON.stringify(messages));
}

/**
 * Writes a TracedMessage[] in two formats:
 *   1. gen_ai.completion.{i}.role / gen_ai.completion.{i}.content  (OTel GenAI conventions)
 *   2. "output" JSON blob (Netra dashboard attribute)
 *
 * Tool-call blocks in the messages are also written to gen_ai.response.tool_calls.*.
 */
export function writeCompletionAttributes(
  span: Span,
  messages: TracedMessage[],
): void {
  if (messages.length === 0) return;

  let completionIdx = 0;

  for (const msg of messages) {
    if (msg.role === "tool") {
      // Tool entries are emitted as tool_call attributes, not completion entries
      try {
        const parsed = JSON.parse(msg.content) as Record<string, unknown>;
        const toolData = {
          name: parsed.name,
          id: parsed.id,
          input: parsed.input,
          arguments: parsed.arguments,
        };
        span.setAttribute(
          `gen_ai.response.completion.${completionIdx}.role`,
          "tool",
        );
        span.setAttribute(
          `gen_ai.response.completion.${completionIdx}.content`,
          JSON.stringify(toolData),
        );
        completionIdx++;
      } catch (error) {
        Logger.error("Error parsing tool content:", error);
      }
    } else {
      span.setAttribute(
        `${SpanAttributes.LLM_COMPLETIONS}.${completionIdx}.role`,
        msg.role,
      );
      span.setAttribute(
        `${SpanAttributes.LLM_COMPLETIONS}.${completionIdx}.content`,
        msg.content,
      );
      completionIdx++;
    }
  }

  span.setAttribute("output", JSON.stringify(messages));
}

// Request Attributes
export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string,
  system: string,
): void {
  if (!span.isRecording()) return;

  // Core identifiers
  span.setAttribute(SpanAttributes.LLM_REQUEST_TYPE, requestType);
  span.setAttribute(SpanAttributes.LLM_SYSTEM, system);

  if (kwargs.model) {
    span.setAttribute(SpanAttributes.LLM_REQUEST_MODEL, String(kwargs.model));
  }

  // Standard model parameters
  setModelParams(span, kwargs);

  // Tool definitions
  if (Array.isArray(kwargs.tools)) {
    span.setAttribute("tools", safeStringify(kwargs.tools));
  }

  // Reasoning config
  if (kwargs.reasoning !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_REQUEST_REASONING,
      JSON.stringify(kwargs.reasoning),
    );
  }

  // Content tracing — extract once, write in bothformats
  if (isTraceContentEnabled()) {
    const messages = buildInputMessages(kwargs, requestType);
    writePromptAttributes(span, messages);

    // Legacy: FIMsuffix
    if (kwargs.suffix !== undefined) {
      span.setAttribute(
        "llm.request.suffix",
        safeStringify(kwargs.suffix),
      );
    }
  }
}

// Response Attributes
export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  if (!span.isRecording()) return;

  // ResponseID
  if (response.id) {
    span.setAttribute("llm.response.id", String(response.id));
  }

  // Model
  const model = response.model || (response.response_metadata as any)?.model;
  if (model) {
    span.setAttribute(SpanAttributes.LLM_RESPONSE_MODEL, String(model));
  }

  // Tokenusage
  setUsageAttributes(span, response);

  // Finish reason (from firstchoice)
  setFinishReason(span, response);

  // Embeddingmetadata
  setEmbeddingResponseMeta(span, response);

  // Content tracing — extract once, write in bothformats
  if (isTraceContentEnabled()) {
    const messages = buildOutputMessages(response);
    writeCompletionAttributes(span, messages);
  }
}

// Response Sub-helpers
function setFinishReason(span: Span, response: Record<string, unknown>): void {
  if (response.stop_reason) {
    span.setAttribute(
      SpanAttributes.LLM_RESPONSE_FINISH_REASON,
      String(response.stop_reason),
    );
    span.setAttribute("gen_ai.response.finish_reason", String(response.stop_reason));
  }

  const choices = response.choices as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(choices) && choices.length > 0) {
    const reason = choices[0].finish_reason ?? choices[0].finishReason;
    if (reason) {
      span.setAttribute(SpanAttributes.LLM_RESPONSE_FINISH_REASON, String(reason));
      span.setAttribute("gen_ai.response.finish_reason", String(reason));
    }
  }
}

function setUsageAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  const usage = (response.usage ?? response.usage_metadata) as
    | Record<string, unknown>
    | undefined;
  if (!usage) return;

  const promptTokens = usage.prompt_tokens ?? usage.input_tokens;
  if (promptTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_PROMPT_TOKENS,
      Number(promptTokens),
    );
  }

  const completionTokens = usage.completion_tokens ?? usage.output_tokens;
  if (completionTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_COMPLETION_TOKENS,
      Number(completionTokens),
    );
  }

  const totalTokens = usage.total_tokens;
  if (totalTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_TOTAL_TOKENS,
      Number(totalTokens),
    );
  }

  const cacheReadTokens =
    usage.cache_read_input_tokens ??
    (
      (usage.prompt_tokens_details ?? usage.input_tokens_details) as
        | { cached_tokens?: unknown }
        | undefined
    )?.cached_tokens;
  if (cacheReadTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_CACHE_READ_INPUT_TOKENS,
      Number(cacheReadTokens),
    );
  }

  const cacheCreationTokens = usage.cache_creation_input_tokens;
  if (cacheCreationTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_CACHE_CREATION_INPUT_TOKENS,
      Number(cacheCreationTokens),
    );
  }

  const reasoningTokens = (
    (usage.completion_tokens_details ?? usage.output_tokens_details) as
      | { reasoning_tokens?: unknown }
      | undefined
  )?.reasoning_tokens;
  if (reasoningTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_REASONING_TOKENS,
      Number(reasoningTokens),
    );
  }
}

function setEmbeddingResponseMeta(
  span: Span,
  response: Record<string, unknown>,
): void {
  const data = response.data as Array<unknown> | undefined;
  if (!Array.isArray(data) || data.length === 0) return;

  span.setAttribute("llm.response.embedding_count", data.length);

  const firstItem = data[0] as Record<string, unknown>;
  const embedding = firstItem?.embedding as number[] | undefined;
  if (Array.isArray(embedding)) {
    span.setAttribute("llm.response.embedding_dimensions", embedding.length);
  }
}
