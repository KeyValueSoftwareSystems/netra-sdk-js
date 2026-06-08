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
import { setRequestAttributes, setResponseAttributes } from "./utils";
import { OpenAIRequestType, StreamResponse, WrapperFn } from "./types";

const SPAN_NAMES: Record<OpenAIRequestType, string> = {
  chat: "openai.chat",
  embedding: "openai.embedding",
  response: "openai.response",
};

const STREAMING_TYPES = new Set<OpenAIRequestType>(["chat", "response"]);

function handleSpanError(span: Span, error: unknown): void {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
  span.recordException(error as Error);
  span.end();
}

function setSpanRequestContext(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: OpenAIRequestType,
): void {
  setRequestAttributes(span, kwargs, requestType);
}

function finalizeSpanSuccess(
  span: Span,
  response: Record<string, unknown>,
  startTime: number,
): void {
  setResponseAttributes(span, response);
  span.setAttribute("llm.response.duration", (Date.now() - startTime) / 1000);
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

abstract class BaseStreamHandler {
  protected completeResponse: StreamResponse = { choices: [], model: "" };
  protected span!: Span;
  protected startTime!: number;
  protected requestKwargs!: Record<string, unknown>;

  constructor(
    span: Span,
    startTime: number,
    requestKwargs: Record<string, unknown>,
  ) {
    // Non-enumerable so JSON.stringify never walks into the OTel span's
    // internal _spanProcessor graph (which is circular).
    Object.defineProperty(this, "span", { value: span, writable: true, enumerable: false });
    Object.defineProperty(this, "startTime", { value: startTime, writable: true, enumerable: false });
    Object.defineProperty(this, "requestKwargs", { value: requestKwargs, writable: true, enumerable: false });
  }

  toJSON(): StreamResponse {
    return this.completeResponse;
  }

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
    if (code === SpanStatusCode.OK) {
      finalizeSpanSuccess(
        this.span,
        this.completeResponse as Record<string, unknown>,
        this.startTime,
      );
    } else {
      this.span.setAttribute(
        "llm.response.duration",
        (Date.now() - this.startTime) / 1000,
      );
      this.span.setStatus({ code });
      this.span.end();
    }
  }
}

export class StreamingWrapper
  extends BaseStreamHandler
  implements Iterable<unknown>
{
  private iterator: Iterator<unknown> | null = null;
  private response: unknown;

  constructor(
    span: Span,
    response: unknown,
    startTime: number,
    requestKwargs: Record<string, unknown>,
  ) {
    super(span, startTime, requestKwargs);
    Object.defineProperty(this, "response", { value: response, writable: true, enumerable: false });
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
  private response: unknown;

  constructor(
    span: Span,
    response: unknown,
    startTime: number,
    requestKwargs: Record<string, unknown>,
  ) {
    super(span, startTime, requestKwargs);
    Object.defineProperty(this, "response", { value: response, writable: true, enumerable: false });
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

function executeStreaming(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: OpenAIRequestType,
  call: () => unknown,
): unknown {
  const startTime = Date.now();
  try {
    setSpanRequestContext(span, kwargs, requestType);
    const response = call();

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

function executeNonStreaming(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: OpenAIRequestType,
  call: () => unknown,
): unknown {
  const startTime = Date.now();
  try {
    setSpanRequestContext(span, kwargs, requestType);
    const result = call();

    if (isPromise(result)) {
      return result.then(
        (value) => {
          finalizeSpanSuccess(span, modelAsDict(value), startTime);
          return value;
        },
        (error) => {
          handleSpanError(span, error);
          throw error;
        },
      );
    }

    finalizeSpanSuccess(span, modelAsDict(result), startTime);
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
  const spanOpts = { kind: SpanKind.CLIENT, attributes: { "llm.request.type": requestType } };

  return (wrapped, instance, args, kwargs) => {
    if (shouldSuppressInstrumentation()) {
      const result = wrapped.call(instance, ...args);
      return isPromise(result) ? result.then((v) => v) : result;
    }

    const call = () => wrapped.call(instance, ...args);
    const isStreaming = kwargs.stream === true && STREAMING_TYPES.has(requestType);

    if (isStreaming) {
      const span = tracer.startSpan(spanName, spanOpts, context.active());
      return executeStreaming(span, kwargs, requestType, call);
    }

    return tracer.startActiveSpan(spanName, spanOpts, (span) =>
      executeNonStreaming(span, kwargs, requestType, call),
    );
  };
}

export const chatWrapper = (tracer: Tracer): WrapperFn =>
  openAIWrapper(tracer, "chat");

export const embeddingsWrapper = (tracer: Tracer): WrapperFn =>
  openAIWrapper(tracer, "embedding");

export const responsesWrapper = (tracer: Tracer): WrapperFn =>
  openAIWrapper(tracer, "response");
