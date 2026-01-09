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

const CHAT_SPAN_NAME = "groq.chat";
type WrappedFunction = (...args: unknown[]) => unknown;

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
        console.error("netra.instrumentation.groq:", error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error as Error);
        span.end();
        throw error;
      }
    } else {
      const result = tracer.startActiveSpan(
        CHAT_SPAN_NAME,
        { kind: SpanKind.CLIENT, attributes: { "llm.request.type": "chat" } },
        async (span: Span) => {
          const startTime = Date.now();
          try {
            setRequestAttributes(span, kwargs, "chat");
            const response = await (wrapped.call(instance, ...args) as Promise<unknown>);
            const endTime = Date.now();
            const responseDict = modelAsDict(response);
            setResponseAttributes(span, responseDict);
            span.setAttribute("llm.response.duration", (endTime - startTime) / 1000);
            span.setStatus({ code: SpanStatusCode.OK });
            return response;
          } catch (error) {
            console.error("netra.instrumentation.groq:", error);
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
      return result;
    }
  };
}


export class StreamingWrapper implements AsyncIterator<unknown> {
  private span: Span;
  private responsePromise: Promise<AsyncIterable<unknown>>;
  private responseIterator?: AsyncIterator<unknown>;
  private startTime: number;
  private requestKwargs: Record<string, unknown>;
  private completeResponse: Record<string, unknown>;
  private initialized: boolean = false;

  constructor(
    span: Span,
    responsePromise: Promise<AsyncIterable<unknown>>,
    startTime: number,
    requestKwargs: Record<string, unknown>
  ) {
    this.span = span;
    this.responsePromise = responsePromise;
    this.startTime = startTime;
    this.requestKwargs = requestKwargs;
    this.completeResponse = { choices: [], model: "" };
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      const response = await this.responsePromise;
      this.responseIterator = response[Symbol.asyncIterator]();
      this.initialized = true;
    }
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

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }

  async next(): Promise<IteratorResult<unknown>> {
    try {
      await this.ensureInitialized();
      if (!this.responseIterator) {
        throw new Error("Response iterator not initialized");
      }
      
      const result = await this.responseIterator.next();
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

