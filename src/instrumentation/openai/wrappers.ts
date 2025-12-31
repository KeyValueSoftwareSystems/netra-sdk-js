/**
 * Wrapper functions for OpenAI instrumentation
 */

import {
  Tracer,
  Span,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import {
  modelAsDict,
  setRequestAttributes,
  setResponseAttributes,
  shouldSuppressInstrumentation,
} from "./utils";

// Span names
const CHAT_SPAN_NAME = "openai.chat";
const EMBEDDING_SPAN_NAME = "openai.embedding";
const RESPONSE_SPAN_NAME = "openai.response";

type WrappedFunction = (...args: unknown[]) => unknown;

/**
 * Wrapper factory for chat completions
 */
export function chatWrapper(tracer: Tracer) {
  return function wrapper(
    wrapped: WrappedFunction,
    instance: unknown,
    args: unknown[],
    kwargs: Record<string, unknown>
  ): unknown {
    if (shouldSuppressInstrumentation()) {
      return wrapped.call(instance, ...args);
    }

    const isStreaming = kwargs.stream === true;

    if (isStreaming) {
      const span = tracer.startSpan(CHAT_SPAN_NAME, {
        kind: SpanKind.CLIENT,
        attributes: { "llm.request.type": "chat" },
      });

      try {
        setRequestAttributes(span, kwargs, "chat");
        const startTime = Date.now();
        const responsePromise = wrapped.call(instance, ...args) as Promise<AsyncIterable<unknown>>;
        return new StreamingWrapper(span, responsePromise, startTime, kwargs);
      } catch (error) {
        console.error("netra.instrumentation.openai:", error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error as Error);
        span.end();
        throw error;
      }
    } else {
      return tracer.startActiveSpan(
        CHAT_SPAN_NAME,
        { kind: SpanKind.CLIENT, attributes: { "llm.request.type": "chat" } },
        async (span: Span) => {
          try {
            setRequestAttributes(span, kwargs, "chat");
            const startTime = Date.now();
            const response = await wrapped.call(instance, ...args) as Promise<unknown>;
            const endTime = Date.now();
            const responseDict = modelAsDict(response);
            setResponseAttributes(span, responseDict);
            span.setAttribute("llm.response.duration", (endTime - startTime) / 1000);
            span.setStatus({ code: SpanStatusCode.OK });
            return response;
          } catch (error) {
            console.error("netra.instrumentation.openai:", error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });
            span.recordException(error as Error);
            throw error;
          } finally {
            span.end();
          }
        }
      );
    }
  };
}

/**
 * Wrapper factory for embeddings
 */
export function embeddingsWrapper(tracer: Tracer) {
  return function wrapper(
    wrapped: WrappedFunction,
    instance: unknown,
    args: unknown[],
    kwargs: Record<string, unknown>
  ): unknown {
    if (shouldSuppressInstrumentation()) {
      return wrapped.call(instance, ...args);
    }

    return tracer.startActiveSpan(
      EMBEDDING_SPAN_NAME,
      { kind: SpanKind.CLIENT, attributes: { "llm.request.type": "embedding" } },
      async (span: Span) => {
        try {
          setRequestAttributes(span, kwargs, "embedding");
          const startTime = Date.now();
          const response = await wrapped.call(instance, ...args) as Promise<unknown>;
          const endTime = Date.now();
          const responseDict = modelAsDict(response);
          setResponseAttributes(span, responseDict);
          span.setAttribute("llm.response.duration", (endTime - startTime) / 1000);
          span.setStatus({ code: SpanStatusCode.OK });
          return response;
        } catch (error) {
          console.error("netra.instrumentation.openai:", error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          span.recordException(error as Error);
          throw error;
        } finally {
          span.end();
        }
      }
    );
  };
}

/**
 * Wrapper factory for responses.create (new OpenAI API)
 */
export function responsesWrapper(tracer: Tracer) {
  return function wrapper(
    wrapped: WrappedFunction,
    instance: unknown,
    args: unknown[],
    kwargs: Record<string, unknown>
  ): unknown {
    if (shouldSuppressInstrumentation()) {
      return wrapped.call(instance, ...args);
    }

    const isStreaming = kwargs.stream === true;

    if (isStreaming) {
      const span = tracer.startSpan(RESPONSE_SPAN_NAME, {
        kind: SpanKind.CLIENT,
        attributes: { "llm.request.type": "response" },
      });

      try {
        setRequestAttributes(span, kwargs, "response");
        const startTime = Date.now();
        const response = wrapped.call(instance, ...args) as Promise<unknown>;
        return new StreamingWrapper(span, response, startTime, kwargs);
      } catch (error) {
        console.error("netra.instrumentation.openai:", error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error as Error);
        span.end();
        throw error;
      }
    } else {
      return tracer.startActiveSpan(
        RESPONSE_SPAN_NAME,
        { kind: SpanKind.CLIENT, attributes: { "llm.request.type": "response" } },
        async (span: Span) => {
          try {
            setRequestAttributes(span, kwargs, "response");
            const startTime = Date.now();
            const response = await wrapped.call(instance, ...args) as Promise<unknown>;
            const endTime = Date.now();
            const responseDict = modelAsDict(response);
            setResponseAttributes(span, responseDict);
            span.setAttribute("llm.response.duration", (endTime - startTime) / 1000);
            span.setStatus({ code: SpanStatusCode.OK });
            return response;
          } catch (error) {
            console.error("netra.instrumentation.openai:", error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });
            span.recordException(error as Error);
            throw error;
          } finally {
            span.end();
          }
        }
      );
    }
  };
}


/**
 * Wrapper for streaming responses
 */
export class StreamingWrapper implements Iterator<unknown> {
  private span: Span;
  private response: Iterator<unknown>;
  private startTime: number;
  private requestKwargs: Record<string, unknown>;
  private completeResponse: Record<string, unknown>;

  constructor(
    span: Span,
    response: unknown,
    startTime: number,
    requestKwargs: Record<string, unknown>
  ) {
    this.span = span;
    this.response = response as Iterator<unknown>;
    this.startTime = startTime;
    this.requestKwargs = requestKwargs;
    this.completeResponse = { choices: [], model: "" };
  }

  private isChat(): boolean {
    return (
      typeof this.requestKwargs === "object" &&
      this.requestKwargs !== null &&
      "messages" in this.requestKwargs
    );
  }

  private ensureChoice(index: number): void {
    const choices = this.completeResponse.choices as Array<Record<string, unknown>>;
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
      const result = this.response.next();
      if (result.done) {
        this.finalizeSpan();
        return result;
      }
      this.processChunk(result.value);
      return result;
    } catch (error) {
      this.finalizeSpan();
      throw error;
    }
  }

  private processChunk(chunk: unknown): void {
    const chunkDict = modelAsDict(chunk);
    const choices = this.completeResponse.choices as Array<Record<string, unknown>>;

    if (chunkDict.model) {
      this.completeResponse.model = chunkDict.model;
    }

    const chunkChoices = (chunkDict.choices || []) as Array<Record<string, unknown>>;

    // Completion API
    if (Array.isArray(chunkChoices)) {
      for (const choice of chunkChoices) {
        const index = Number(choice.index || 0);
        this.ensureChoice(index);

        const delta = (choice.delta || {}) as Record<string, unknown>;
        if (typeof delta === "object" && delta.content) {
          const contentPiece = String(delta.content || "");
          const choiceEntry = choices[index];
          if (!choiceEntry.message) {
            choiceEntry.message = { role: "assistant", content: "" };
          }
          const message = choiceEntry.message as Record<string, unknown>;
          message.content = String(message.content || "") + contentPiece;
        }

        if (choice.finish_reason) {
          choices[index].finish_reason = choice.finish_reason;
        }
      }
    }

    if (chunkDict.usage && typeof chunkDict.usage === "object") {
      this.completeResponse.usage = chunkDict.usage;
    }

    // Response API
    if (chunkDict.response) {
      const response = chunkDict.response as Record<string, unknown>;
      if (response.status === "completed") {
        const responseOutput = (response.output || []) as Array<Record<string, unknown>>;
        for (const output of responseOutput) {
          const content = output.content as Array<Record<string, unknown>>;
          if (content) {
            for (const contentItem of content) {
              const assistantText = contentItem.text || "";
              this.completeResponse.choices = [
                { message: { role: "assistant", content: assistantText } },
              ];
            }
          }
        }

        const usage = response.usage || {};
        this.completeResponse.usage = usage;
      }
    }

    this.span.addEvent("llm.content.completion.chunk");
  }

  private finalizeSpan(): void {
    const endTime = Date.now();
    const duration = (endTime - this.startTime) / 1000;
    setResponseAttributes(this.span, this.completeResponse);
    this.span.setAttribute("llm.response.duration", duration);
    this.span.setStatus({ code: SpanStatusCode.OK });
    this.span.end();
  }
}

