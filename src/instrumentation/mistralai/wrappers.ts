/**
 * Wrapper functions for MistralAI instrumentation
 */

import {
  Span,
  SpanKind,
  SpanStatusCode,
  Tracer,
  context,
} from "@opentelemetry/api";
import { Logger } from "../../logger";
import { defineHidden, isPromise, recordResponseTiming, recordSpanTiming } from "../utils";
import { SpanAttributes } from "../span-attributes";
import {
  modelAsDict,
  setRequestAttributes,
  setResponseAttributes,
  shouldSuppressInstrumentation,
} from "./utils";

// Span names
const CHAT_SPAN_NAME = "mistralai.chat";
const EMBEDDING_SPAN_NAME = "mistralai.embedding";
const FIM_SPAN_NAME = "mistralai.fim";
const AGENTS_SPAN_NAME = "mistralai.agents";
// Align with OpenAI/Groq: streaming uses same span name
const CHAT_STREAM_SPAN_NAME = CHAT_SPAN_NAME;
const FIM_STREAM_SPAN_NAME = FIM_SPAN_NAME;
const AGENTS_STREAM_SPAN_NAME = AGENTS_SPAN_NAME;

type MistralRequestType = "chat" | "embedding" | "fim" | "agent";

function mistralWrapper(
  tracer: Tracer,
  spanName: string,
  requestType: MistralRequestType
) {
  return function wrapper<F extends (...args: any[]) => any>(
    wrapped: F,
    instance: unknown,
    args: Parameters<F>,
    kwargs: Record<string, unknown>
  ): unknown {
    if (shouldSuppressInstrumentation()) {
      const result = wrapped.call(instance, ...args);
      return isPromise(result) ? result.then((value) => value) : result;
    }

    return tracer.startActiveSpan(
      spanName,
      {
        kind: SpanKind.CLIENT,
        attributes: { "llm.request.type": requestType },
      },
      (span: Span) => {
        try {
          setRequestAttributes(span, kwargs, requestType);
          const startTime = Date.now();
          const response = wrapped.call(instance, ...args);
          if (isPromise(response)) {
            return (async () => {
              try {
                const value = await response;
                const endTime = Date.now();
                setResponseAttributes(span, modelAsDict(value));
                recordResponseTiming(span, { startTime, eventTime: endTime });
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                return value;
              } catch (error) {
                Logger.error("netra.instrumentation.mistralai:", error);
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message:
                    error instanceof Error ? error.message : String(error),
                });
                span.recordException(error as Error);
                span.end();
                throw error;
              }
            })();
          }

          const endTime = Date.now();
          setResponseAttributes(span, modelAsDict(response));
          recordResponseTiming(span, { startTime, eventTime: endTime });
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return response;
        } catch (error) {
          Logger.error("netra.instrumentation.mistralai:", error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          span.recordException(error as Error);
          span.end();
          throw error;
        }
      }
    );
  };
}

function mistralStreamWrapper(
  tracer: Tracer,
  spanName: string,
  requestType: MistralRequestType
) {
  return function wrapper<F extends (...args: any[]) => any>(
    wrapped: F,
    instance: unknown,
    args: Parameters<F>,
    kwargs: Record<string, unknown>
  ): unknown {
    if (shouldSuppressInstrumentation()) {
      const result = wrapped.call(instance, ...args);
      return isPromise(result) ? result.then((value) => value) : result;
    }

    // IMPORTANT: Pass the active context to inherit parent span
    const currentContext = context.active();
    const span = tracer.startSpan(
      spanName,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "llm.request.type": requestType,
          "llm.request.stream": true,
        },
      },
      currentContext
    );

    try {
      // Force stream=true for attribution
      setRequestAttributes(span, { ...kwargs, stream: true }, requestType);
      const startTime = Date.now();
      const response = wrapped.call(instance, ...args);
      if (isPromise(response)) {
        return (async () => {
          try {
            const stream = await response;
            if (
              stream &&
              typeof stream === "object" &&
              Symbol.asyncIterator in (stream as any)
            ) {
              return new AsyncStreamingWrapper(span, stream, startTime, kwargs);
            }
            return new StreamingWrapper(span, stream, startTime, kwargs);
          } catch (error) {
            Logger.error("netra.instrumentation.mistralai:", error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });
            span.recordException(error as Error);
            span.end();
            throw error;
          }
        })();
      }
      if (
        response &&
        typeof response === "object" &&
        Symbol.asyncIterator in (response as any)
      ) {
        return new AsyncStreamingWrapper(span, response, startTime, kwargs);
      }
      return new StreamingWrapper(span, response, startTime, kwargs);
    } catch (error) {
      Logger.error("netra.instrumentation.mistralai:", error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error as Error);
      span.end();
      throw error;
    }
  };
}

/**
 * Wrapper factory for chat completions
 */
export const chatWrapper = (tracer: Tracer) =>
  mistralWrapper(tracer, CHAT_SPAN_NAME, "chat");

/**
 * Wrapper factory for chat stream
 */
export const chatStreamWrapper = (tracer: Tracer) =>
  mistralStreamWrapper(tracer, CHAT_STREAM_SPAN_NAME, "chat");

/**
 * Wrapper factory for embeddings
 */
export const embeddingsWrapper = (tracer: Tracer) =>
  mistralWrapper(tracer, EMBEDDING_SPAN_NAME, "embedding");

/**
 * Wrapper factory for FIM completions
 */
export const fimWrapper = (tracer: Tracer) =>
  mistralWrapper(tracer, FIM_SPAN_NAME, "fim");

/**
 * Wrapper factory for FIM stream
 */
export const fimStreamWrapper = (tracer: Tracer) =>
  mistralStreamWrapper(tracer, FIM_STREAM_SPAN_NAME, "fim");

/**
 * Wrapper factory for agents completions
 */
export const agentsWrapper = (tracer: Tracer) =>
  mistralWrapper(tracer, AGENTS_SPAN_NAME, "agent");

/**
 * Wrapper factory for agents stream
 */
export const agentsStreamWrapper = (tracer: Tracer) =>
  mistralStreamWrapper(tracer, AGENTS_STREAM_SPAN_NAME, "agent");

/**
 * Wrapper for streaming responses when the SDK returns a sync Iterable/Iterator.
 * (Matches the newer OpenAI/Groq wrapper behavior.)
 */
export class StreamingWrapper implements Iterable<unknown>, Iterator<unknown> {
  private iterator: Iterator<unknown> | null = null;
  private completeResponse: Record<string, unknown> = {
    choices: [],
    model: "",
  };
  // Assigned via defineHidden in constructor (non-enumerable to avoid circular JSON)
  private span!: Span;
  private response!: unknown;
  private startTime!: number;
  private requestKwargs!: Record<string, unknown>;
  private firstTokenRecorded = false;

  constructor(span: Span, response: unknown, startTime: number, requestKwargs: Record<string, unknown>) {
    defineHidden(this, "span", span);
    defineHidden(this, "response", response);
    defineHidden(this, "startTime", startTime);
    defineHidden(this, "requestKwargs", requestKwargs);
  }

  toJSON() {
    return this.completeResponse;
  }

  private isChat(): boolean {
    return (
      typeof this.requestKwargs === "object" &&
      this.requestKwargs !== null &&
      "messages" in this.requestKwargs
    );
  }

  private ensureChoice(index: number): void {
    const choices = this.completeResponse.choices as Array<
      Record<string, unknown>
    >;
    while (choices.length <= index) {
      if (this.isChat()) {
        choices.push({ message: { role: "assistant", content: "" } });
      } else {
        choices.push({ text: "" });
      }
    }
  }

  [Symbol.iterator](): Iterator<unknown> {
    return this;
  }

  next(): IteratorResult<unknown> {
    try {
      if (!this.iterator) {
        const isObject = this.response && typeof this.response === "object";
        if (!isObject) throw new Error("Response is not an iterable");

        if (typeof (this.response as any)[Symbol.iterator] === "function") {
          this.iterator = (this.response as Iterable<unknown>)[
            Symbol.iterator
          ]();
        } else if (
          typeof (this.response as Iterator<unknown>).next === "function"
        ) {
          this.iterator = this.response as Iterator<unknown>;
        } else {
          throw new Error("Response is not an iterable");
        }
      }

      if (!this.iterator) throw new Error("Iterator not initialized");

      const result = this.iterator.next();
      if (result.done) {
        this.finalizeSpan();
        return result;
      }
      this.processChunk(result.value);
      return result;
    } catch (error) {
      this.finalizeSpan(error);
      throw error;
    }
  }

  private processChunk(chunk: unknown): void {
    const chunkDict = modelAsDict(chunk);
    const choices = this.completeResponse.choices as Array<
      Record<string, unknown>
    >;

    if (chunkDict.model) {
      this.completeResponse.model = chunkDict.model;
    }

    // Handle CompletionEvent structure from MistralAI
    const data = chunkDict.data as Record<string, unknown> | undefined;
    if (data) {
      if (data.model) {
        this.completeResponse.model = data.model;
      }

      const dataChoices = (data.choices || []) as Array<
        Record<string, unknown>
      >;
      if (Array.isArray(dataChoices)) {
        for (const choice of dataChoices) {
          const index = Number(choice.index || 0);
          this.ensureChoice(index);

          const delta = (choice.delta || {}) as Record<string, unknown>;
          if (typeof delta === "object" && delta.content) {
            if (!this.firstTokenRecorded) {
              this.firstTokenRecorded = true;
              recordResponseTiming(this.span);
            }
            const contentPiece = String(delta.content || "");
            const choiceEntry = choices[index];
            if (this.isChat()) {
              if (!choiceEntry.message) {
                choiceEntry.message = { role: "assistant", content: "" };
              }
              const message = choiceEntry.message as Record<string, unknown>;
              message.content = String(message.content || "") + contentPiece;
            } else {
              choiceEntry.text = String(choiceEntry.text || "") + contentPiece;
            }
          }

          if (choice.finishReason) {
            choices[index].finishReason = choice.finishReason;
          }
        }
      }

      if (data.usage && typeof data.usage === "object") {
        this.completeResponse.usage = data.usage;
      }
    }

    // Also handle direct choices (for backwards compatibility)
    const chunkChoices = (chunkDict.choices || []) as Array<
      Record<string, unknown>
    >;
    if (Array.isArray(chunkChoices) && chunkChoices.length > 0) {
      for (const choice of chunkChoices) {
        const index = Number(choice.index || 0);
        this.ensureChoice(index);

        const delta = (choice.delta || {}) as Record<string, unknown>;
        if (typeof delta === "object" && delta.content) {
          if (!this.firstTokenRecorded) {
            this.firstTokenRecorded = true;
            recordResponseTiming(this.span);
          }
          const contentPiece = String(delta.content || "");
          const choiceEntry = choices[index];
          if (this.isChat()) {
            if (!choiceEntry.message) {
              choiceEntry.message = { role: "assistant", content: "" };
            }
            const message = choiceEntry.message as Record<string, unknown>;
            message.content = String(message.content || "") + contentPiece;
          } else {
            choiceEntry.text = String(choiceEntry.text || "") + contentPiece;
          }
        }

        if (choice.finishReason) {
          choices[index].finishReason = choice.finishReason;
        }
      }
    }

    if (chunkDict.usage && typeof chunkDict.usage === "object") {
      this.completeResponse.usage = chunkDict.usage;
    }

    this.span.addEvent("llm.content.completion.chunk");
  }

  private finalizeSpan(error?: unknown): void {
    setResponseAttributes(this.span, this.completeResponse);
    recordSpanTiming(this.span, SpanAttributes.LLM_RESPONSE_DURATION, undefined, { referenceTime: this.startTime });
    if (error) {
      this.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      try {
        this.span.recordException(error as Error);
      } catch {
        // Ignore
      }
    } else {
      this.span.setStatus({ code: SpanStatusCode.OK });
    }
    this.span.end();
  }
}

/**
 * Async wrapper for streaming responses (AsyncIterable from MistralAI SDK)
 */
export class AsyncStreamingWrapper
  implements AsyncIterable<unknown>, AsyncIterator<unknown>
{
  // Assigned via defineHidden in constructor (non-enumerable to avoid circular JSON)
  private span!: Span;
  private response!: unknown;
  private iterator: AsyncIterator<unknown> | null = null;
  private startTime!: number;
  private requestKwargs!: Record<string, unknown>;
  private completeResponse: Record<string, unknown>;
  private firstTokenRecorded = false;

  constructor(
    span: Span,
    response: unknown,
    startTime: number,
    requestKwargs: Record<string, unknown>
  ) {
    defineHidden(this, "span", span);
    defineHidden(this, "response", response);
    defineHidden(this, "startTime", startTime);
    defineHidden(this, "requestKwargs", requestKwargs);
    this.completeResponse = { choices: [], model: "" };
  }

  toJSON() {
    return this.completeResponse;
  }

  private isChat(): boolean {
    return (
      typeof this.requestKwargs === "object" &&
      this.requestKwargs !== null &&
      "messages" in this.requestKwargs
    );
  }

  private ensureChoice(index: number): void {
    const choices = this.completeResponse.choices as Array<
      Record<string, unknown>
    >;
    while (choices.length <= index) {
      if (this.isChat()) {
        choices.push({ message: { role: "assistant", content: "" } });
      } else {
        choices.push({ text: "" });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }

  async next(): Promise<IteratorResult<unknown>> {
    try {
      // Initialize the iterator on first call
      if (!this.iterator) {
        // Check if response is an AsyncIterable and get the iterator
        if (
          this.response &&
          typeof this.response === "object" &&
          Symbol.asyncIterator in this.response
        ) {
          this.iterator = (this.response as AsyncIterable<unknown>)[
            Symbol.asyncIterator
          ]();
        } else if (
          this.response &&
          typeof this.response === "object" &&
          Symbol.iterator in (this.response as any)
        ) {
          // Handle sync iterables
          const syncIterator = (this.response as Iterable<unknown>)[
            Symbol.iterator
          ]();
          this.iterator = {
            async next() {
              return syncIterator.next();
            },
          };
        } else if (
          this.response &&
          typeof this.response === "object" &&
          typeof (this.response as AsyncIterator<unknown>).next === "function"
        ) {
          // Already an iterator
          this.iterator = this.response as AsyncIterator<unknown>;
        } else {
          throw new Error("Response is not iterable");
        }
      }

      const result = await this.iterator.next();
      if (result.done) {
        this.finalizeSpan();
        return result;
      }
      this.processChunk(result.value);
      return result;
    } catch (error) {
      this.finalizeSpan(error);
      throw error;
    }
  }

  private processChunk(chunk: unknown): void {
    const chunkDict = modelAsDict(chunk);
    const choices = this.completeResponse.choices as Array<
      Record<string, unknown>
    >;

    if (chunkDict.model) {
      this.completeResponse.model = chunkDict.model;
    }

    // Handle CompletionEvent structure from MistralAI
    const data = chunkDict.data as Record<string, unknown> | undefined;
    if (data) {
      if (data.model) {
        this.completeResponse.model = data.model;
      }

      const dataChoices = (data.choices || []) as Array<
        Record<string, unknown>
      >;
      if (Array.isArray(dataChoices)) {
        for (const choice of dataChoices) {
          const index = Number(choice.index || 0);
          this.ensureChoice(index);

          const delta = (choice.delta || {}) as Record<string, unknown>;
          if (typeof delta === "object" && delta.content) {
            if (!this.firstTokenRecorded) {
              this.firstTokenRecorded = true;
              recordResponseTiming(this.span);
            }
            const contentPiece = String(delta.content || "");
            const choiceEntry = choices[index];
            if (this.isChat()) {
              if (!choiceEntry.message) {
                choiceEntry.message = { role: "assistant", content: "" };
              }
              const message = choiceEntry.message as Record<string, unknown>;
              message.content = String(message.content || "") + contentPiece;
            } else {
              choiceEntry.text = String(choiceEntry.text || "") + contentPiece;
            }
          }

          if (choice.finishReason) {
            choices[index].finishReason = choice.finishReason;
          }
        }
      }

      if (data.usage && typeof data.usage === "object") {
        this.completeResponse.usage = data.usage;
      }
    }

    // Also handle direct choices (for backwards compatibility)
    const chunkChoices = (chunkDict.choices || []) as Array<
      Record<string, unknown>
    >;
    if (Array.isArray(chunkChoices) && chunkChoices.length > 0) {
      for (const choice of chunkChoices) {
        const index = Number(choice.index || 0);
        this.ensureChoice(index);

        const delta = (choice.delta || {}) as Record<string, unknown>;
        if (typeof delta === "object" && delta.content) {
          if (!this.firstTokenRecorded) {
            this.firstTokenRecorded = true;
            recordResponseTiming(this.span);
          }
          const contentPiece = String(delta.content || "");
          const choiceEntry = choices[index];
          if (this.isChat()) {
            if (!choiceEntry.message) {
              choiceEntry.message = { role: "assistant", content: "" };
            }
            const message = choiceEntry.message as Record<string, unknown>;
            message.content = String(message.content || "") + contentPiece;
          } else {
            choiceEntry.text = String(choiceEntry.text || "") + contentPiece;
          }
        }

        if (choice.finishReason) {
          choices[index].finishReason = choice.finishReason;
        }
      }
    }

    if (chunkDict.usage && typeof chunkDict.usage === "object") {
      this.completeResponse.usage = chunkDict.usage;
    }

    this.span.addEvent("llm.content.completion.chunk");
  }

  private finalizeSpan(error?: unknown): void {
    setResponseAttributes(this.span, this.completeResponse);
    recordSpanTiming(this.span, SpanAttributes.LLM_RESPONSE_DURATION, undefined, { referenceTime: this.startTime });
    if (error) {
      this.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      try {
        this.span.recordException(error as Error);
      } catch {
        // Ignore
      }
    } else {
      this.span.setStatus({ code: SpanStatusCode.OK });
    }
    this.span.end();
  }
}
