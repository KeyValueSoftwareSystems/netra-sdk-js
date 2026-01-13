import { Tracer, Span, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { setRequestAttributes, setResponseAttributes } from "./utils";
import {
  modelAsDict,
  isPromise,
  shouldSuppressInstrumentation,
} from "../utils";

type OpenAIRequestType = "chat" | "embedding" | "response";

const CHAT_SPAN_NAME = "openai.chat";
const EMBEDDING_SPAN_NAME = "openai.embedding";
const RESPONSE_SPAN_NAME = "openai.response";
const STREAM_ENABLED_REQUESTS: OpenAIRequestType[] = ["chat", "response"];

function openAIWrapper(
  tracer: Tracer,
  spanName: string,
  requestType: OpenAIRequestType
) {
  return function wrapper<F extends (...args: any[]) => any>(
    wrapped: F,
    instance: unknown,
    args: Parameters<F>,
    kwargs: Record<string, unknown> & { stream?: boolean }
  ): unknown {
    if (shouldSuppressInstrumentation()) {
      const result = wrapped.call(instance, ...args);
      return isPromise(result) ? result.then((value) => value) : result;
    }

    const isStreaming = kwargs.stream === true;
    if (isStreaming && STREAM_ENABLED_REQUESTS.includes(requestType)) {
      const span = tracer.startSpan(spanName, {
        kind: SpanKind.CLIENT,
        attributes: { "llm.request.type": requestType },
      });

      try {
        setRequestAttributes(span, kwargs, requestType);
        const startTime = Date.now();
        const response = wrapped.call(instance, ...args);
        if (isPromise(response)) {
          return (async () => {
            try {
              const stream = await response;
              return new AsyncStreamingWrapper(span, stream, startTime, kwargs);
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
          })();
        } else {
          return new StreamingWrapper(span, response, startTime, kwargs);
        }
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
                  const responseDict = modelAsDict(value);
                  setResponseAttributes(span, responseDict);
                  span.setAttribute(
                    "llm.response.duration",
                    (endTime - startTime) / 1000
                  );
                  span.setStatus({ code: SpanStatusCode.OK });
                  span.end();
                  return value;
                } catch (error) {
                  console.error("netra.instrumentation.openai:", error);
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
            } else {
              const endTime = Date.now();
              const responseDict = modelAsDict(response);
              setResponseAttributes(span, responseDict);
              span.setAttribute(
                "llm.response.duration",
                (endTime - startTime) / 1000
              );
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();
              return response;
            }
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
        }
      );
    }
  };
}

/* Specific wrappers for different requests */
export const chatWrapper = (tracer: Tracer) =>
  openAIWrapper(tracer, CHAT_SPAN_NAME, "chat");

export const embeddingsWrapper = (tracer: Tracer) =>
  openAIWrapper(tracer, EMBEDDING_SPAN_NAME, "embedding");

export const responsesWrapper = (tracer: Tracer) =>
  openAIWrapper(tracer, RESPONSE_SPAN_NAME, "response");

/**
 * Wrapper for streaming responses (handles AsyncIterable from OpenAI SDK)
 */
export class StreamingWrapper
  implements AsyncIterable<unknown>, AsyncIterator<unknown>
{
  private span: Span;
  private response: unknown;
  private resolvedResponse: AsyncIterable<unknown> | null = null;
  private iterator: AsyncIterator<unknown> | null = null;
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
    this.response = response;
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

  private isPromise(obj: unknown): obj is Promise<unknown> {
    return (
      obj !== null &&
      typeof obj === "object" &&
      typeof (obj as Promise<unknown>).then === "function"
    );
  }

  async next(): Promise<IteratorResult<unknown>> {
    try {
      // Initialize the iterator on first call
      if (!this.iterator) {
        // If response is a Promise, await it first to get the actual stream
        if (this.isPromise(this.response)) {
          this.resolvedResponse = (await this
            .response) as AsyncIterable<unknown>;
        } else {
          this.resolvedResponse = this.response as AsyncIterable<unknown>;
        }

        // Now check if the resolved response is iterable
        if (Symbol.asyncIterator in this.resolvedResponse) {
          this.iterator = (this.resolvedResponse as AsyncIterable<unknown>)[
            Symbol.asyncIterator
          ]();
        } else if (Symbol.iterator in (this.resolvedResponse as any)) {
          // Handle sync iterables wrapped as async
          const syncIterator = (this.resolvedResponse as Iterable<unknown>)[
            Symbol.iterator
          ]();
          this.iterator = {
            async next() {
              return syncIterator.next();
            },
          };
        } else {
          throw new Error("Response is not iterable");
        }
      }

      const result = await this.iterator.next();
      if (result.done) {
        this.finalizeSpan(SpanStatusCode.OK);
        return result;
      }
      this.processChunk(result.value);
      return result;
    } catch (error) {
      this.finalizeSpan(SpanStatusCode.ERROR);
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

    const chunkChoices = (chunkDict.choices || []) as Array<
      Record<string, unknown>
    >;

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
        const responseOutput = (response.output || []) as Array<
          Record<string, unknown>
        >;
        for (const output of responseOutput) {
          const content = output.content as Array<Record<string, unknown>>;
          if (content) {
            for (const contentItem of content) {
              const assistantText = contentItem.text || "";
              // Append to choices array instead of replacing
              (
                this.completeResponse.choices as Array<Record<string, unknown>>
              ).push({
                message: { role: "assistant", content: assistantText },
              });
            }
          }
        }

        const usage = response.usage || {};
        this.completeResponse.usage = usage;
      }
    }

    this.span.addEvent("llm.content.completion.chunk");
  }

  private finalizeSpan(spanStatus: SpanStatusCode = SpanStatusCode.OK): void {
    const endTime = Date.now();
    const duration = (endTime - this.startTime) / 1000;
    setResponseAttributes(this.span, this.completeResponse);
    this.span.setAttribute("llm.response.duration", duration);
    this.span.setStatus({ code: spanStatus });
    this.span.end();
  }
}

/**
 * Async wrapper for streaming responses
 */
export class AsyncStreamingWrapper
  implements AsyncIterable<unknown>, AsyncIterator<unknown>
{
  private span: Span;
  private response: unknown;
  private iterator: AsyncIterator<unknown> | null = null;
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
    this.response = response;
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
        this.finalizeSpan(SpanStatusCode.OK);
        return result;
      }
      this.processChunk(result.value);
      return result;
    } catch (error) {
      this.finalizeSpan(SpanStatusCode.ERROR);
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

    const chunkChoices = (chunkDict.choices || []) as Array<
      Record<string, unknown>
    >;

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
        const responseOutput = (response.output || []) as Array<
          Record<string, unknown>
        >;
        for (const output of responseOutput) {
          const content = output.content as Array<Record<string, unknown>>;
          if (content) {
            for (const contentItem of content) {
              const assistantText = contentItem.text || "";
              // Append to choices array instead of replacing
              (
                this.completeResponse.choices as Array<Record<string, unknown>>
              ).push({
                message: { role: "assistant", content: assistantText },
              });
            }
          }
        }

        const usage = response.usage || {};
        this.completeResponse.usage = usage;
      }
    }

    this.span.addEvent("llm.content.completion.chunk");
  }

  private finalizeSpan(spanStatus: SpanStatusCode = SpanStatusCode.OK): void {
    const endTime = Date.now();
    const duration = (endTime - this.startTime) / 1000;
    setResponseAttributes(this.span, this.completeResponse);
    this.span.setAttribute("llm.response.duration", duration);
    this.span.setStatus({ code: spanStatus });
    this.span.end();
  }
}
