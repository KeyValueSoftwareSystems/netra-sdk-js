import {
  context,
  Span,
  SpanKind,
  SpanStatusCode,
  Tracer,
} from "@opentelemetry/api";
import {
  isPromise,
  modelAsDict,
  shouldSuppressInstrumentation,
} from "../utils";
import {
  setInputAttribute,
  setOutputAttribute,
  setRequestAttributes,
  setResponseAttributes,
} from "./utils";
import { OpenAIRequestType, StreamResponse, WrapperFn } from "./types";

const SPAN_NAMES: Record<OpenAIRequestType, string> = {
  chat: "openai.chat",
  embedding: "openai.embedding",
  response: "openai.response",
};

const STREAMING_TYPES = new Set<OpenAIRequestType>(["chat", "response"]);

abstract class BaseStreamHandler {
  protected completeResponse: StreamResponse = { choices: [], model: "" };

  constructor(
    protected span: Span,
    protected startTime: number,
    protected requestKwargs: Record<string, unknown>,
  ) {}

  protected processChunk(chunk: unknown): void {
    const chunkDict = modelAsDict(chunk);

    if (chunkDict.model) {
      this.completeResponse.model = String(chunkDict.model);
    }

    const chunkChoices = chunkDict.choices;
    if (Array.isArray(chunkChoices)) {
      for (const choice of chunkChoices as Array<Record<string, unknown>>) {
        const index = Number(choice.index ?? 0);
        this.ensureChoice(index);
        const delta = (choice.delta ?? {}) as Record<string, unknown>;
        if (delta.content) {
          const entry = this.completeResponse.choices[index];
          if (!entry.message) {
            entry.message = { role: "assistant", content: "" };
          }
          const msg = entry.message as Record<string, unknown>;
          msg.content = String(msg.content ?? "") + String(delta.content);
        }
        if (choice.finish_reason) {
          this.completeResponse.choices[index].finish_reason =
            choice.finish_reason;
        }
      }
    }

    if (chunkDict.usage) {
      this.completeResponse.usage = chunkDict.usage;
    }

    // Responses API: final response object arrives in a chunk
    const responseChunk = chunkDict.response as
      | Record<string, unknown>
      | undefined;
    if (responseChunk?.status === "completed") {
      const outputs = (responseChunk.output ?? []) as Array<
        Record<string, unknown>
      >;
      for (const out of outputs) {
        const content = out.content as
          | Array<Record<string, unknown>>
          | undefined;
        if (Array.isArray(content)) {
          for (const item of content) {
            this.completeResponse.choices.push({
              message: { role: "assistant", content: String(item.text ?? "") },
            });
          }
        }
      }
      this.completeResponse.usage = responseChunk.usage ?? {};
    }

    this.span.addEvent("llm.content.completion.chunk");
  }

  protected ensureChoice(index: number): void {
    const isChat = Array.isArray(this.requestKwargs.messages);
    while (this.completeResponse.choices.length <= index) {
      this.completeResponse.choices.push(
        isChat ? { message: { role: "assistant", content: "" } } : { text: "" },
      );
    }
  }

  protected finalizeSpan(code: SpanStatusCode): void {
    const duration = (Date.now() - this.startTime) / 1000;
    if (code === SpanStatusCode.OK) {
      const response = this.completeResponse as Record<string, unknown>;
      setResponseAttributes(this.span, response);
      setOutputAttribute(this.span, response);
    }
    this.span.setAttribute("llm.response.duration", duration);
    this.span.setStatus({ code });
    this.span.end();
  }
}

export class StreamingWrapper
  extends BaseStreamHandler
  implements Iterable<unknown>
{
  private iterator: Iterator<unknown> | null = null;

  constructor(
    span: Span,
    private response: unknown,
    startTime: number,
    requestKwargs: Record<string, unknown>,
  ) {
    super(span, startTime, requestKwargs);
  }

  [Symbol.iterator](): Iterator<unknown> {
    return this;
  }

  next(): IteratorResult<unknown> {
    try {
      if (!this.iterator) {
        this.iterator = this.resolveIterator();
      }
      const result = this.iterator.next();
      if (result.done) {
        this.finalizeSpan(SpanStatusCode.OK);
      } else {
        this.processChunk(result.value);
      }
      return result;
    } catch (error) {
      this.finalizeSpan(SpanStatusCode.ERROR);
      throw error;
    }
  }

  private resolveIterator(): Iterator<unknown> {
    if (!this.response || typeof this.response !== "object") {
      throw new Error("Response is not iterable");
    }
    if (Symbol.iterator in (this.response as object)) {
      return (this.response as Iterable<unknown>)[Symbol.iterator]();
    }
    if (typeof (this.response as Iterator<unknown>).next === "function") {
      return this.response as Iterator<unknown>;
    }
    throw new Error("Response is not iterable");
  }
}

export class AsyncStreamingWrapper
  extends BaseStreamHandler
  implements AsyncIterable<unknown>
{
  private iterator: AsyncIterator<unknown> | null = null;

  constructor(
    span: Span,
    private response: unknown,
    startTime: number,
    requestKwargs: Record<string, unknown>,
  ) {
    super(span, startTime, requestKwargs);
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }

  async next(): Promise<IteratorResult<unknown>> {
    try {
      if (!this.iterator) {
        this.iterator = this.resolveIterator();
      }
      const result = await this.iterator.next();
      if (result.done) {
        this.finalizeSpan(SpanStatusCode.OK);
      } else {
        this.processChunk(result.value);
      }
      return result;
    } catch (error) {
      this.finalizeSpan(SpanStatusCode.ERROR);
      throw error;
    }
  }

  private resolveIterator(): AsyncIterator<unknown> {
    if (!this.response || typeof this.response !== "object") {
      throw new Error("Response is not iterable");
    }
    if (Symbol.asyncIterator in (this.response as object)) {
      return (this.response as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    }
    if (Symbol.iterator in (this.response as object)) {
      const syncIter = (this.response as Iterable<unknown>)[Symbol.iterator]();
      return {
        async next() {
          return syncIter.next();
        },
      };
    }
    if (typeof (this.response as AsyncIterator<unknown>).next === "function") {
      return this.response as AsyncIterator<unknown>;
    }
    throw new Error("Response is not iterable");
  }
}

function handleSpanError(span: Span, error: unknown): void {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
  span.recordException(error as Error);
  span.end();
}

function executeNonStreaming(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: OpenAIRequestType,
  call: () => unknown,
): unknown {
  const startTime = Date.now();
  try {
    setRequestAttributes(span, kwargs, requestType);
    setInputAttribute(span, kwargs, requestType);
    const result = call();
    if (isPromise(result)) {
      return result.then(
        (value) => {
          const responseDict = modelAsDict(value);
          setResponseAttributes(span, responseDict);
          setOutputAttribute(span, responseDict);
          span.setAttribute(
            "llm.response.duration",
            (Date.now() - startTime) / 1000,
          );
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return value;
        },
        (error) => {
          handleSpanError(span, error);
          throw error;
        },
      );
    }
    const responseDict = modelAsDict(result);
    setResponseAttributes(span, responseDict);
    setOutputAttribute(span, responseDict);
    span.setAttribute("llm.response.duration", (Date.now() - startTime) / 1000);
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return result;
  } catch (error) {
    handleSpanError(span, error);
    throw error;
  }
}

function openAIWrapper(
  tracer: Tracer,
  requestType: OpenAIRequestType,
): WrapperFn {
  const spanName = SPAN_NAMES[requestType];
  const spanAttrs = { "llm.request.type": requestType };

  return (wrapped, instance, args, kwargs) => {
    if (shouldSuppressInstrumentation()) {
      const result = wrapped.call(instance, ...args);
      return isPromise(result) ? result.then((v) => v) : result;
    }

    const isStreaming =
      kwargs.stream === true && STREAMING_TYPES.has(requestType);

    if (isStreaming) {
      const span = tracer.startSpan(
        spanName,
        { kind: SpanKind.CLIENT, attributes: spanAttrs },
        context.active(),
      );
      try {
        setRequestAttributes(span, kwargs, requestType);
        setInputAttribute(span, kwargs, requestType);
        const startTime = Date.now();
        const response = wrapped.call(instance, ...args);
        if (isPromise(response)) {
          return (async () => {
            try {
              const stream = await response;
              return new AsyncStreamingWrapper(span, stream, startTime, kwargs);
            } catch (error) {
              handleSpanError(span, error);
              throw error;
            }
          })();
        }
        return new StreamingWrapper(span, response, startTime, kwargs);
      } catch (error) {
        handleSpanError(span, error);
        throw error;
      }
    }

    return tracer.startActiveSpan(
      spanName,
      { kind: SpanKind.CLIENT, attributes: spanAttrs },
      (span) =>
        executeNonStreaming(span, kwargs, requestType, () =>
          wrapped.call(instance, ...args),
        ),
    );
  };
}

export const chatWrapper = (tracer: Tracer): WrapperFn =>
  openAIWrapper(tracer, "chat");

export const embeddingsWrapper = (tracer: Tracer): WrapperFn =>
  openAIWrapper(tracer, "embedding");

export const responsesWrapper = (tracer: Tracer): WrapperFn =>
  openAIWrapper(tracer, "response");
