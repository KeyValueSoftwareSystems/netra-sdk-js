import {
  Context,
  Span,
  SpanKind,
  SpanStatusCode,
  Tracer,
  context,
  trace,
} from "@opentelemetry/api";
import {
  defineHidden,
  isPromise,
  modelAsDict,
  shouldSuppressInstrumentation,
} from "../utils";
import {
  isAsyncIterable,
  wrapPromise,
  wrapResponse,
} from "../../utils/response-handler";
import { setRequestAttributes, setResponseAttributes } from "./utils";
import { OpenAIRequestType, StreamResponse, WrapperFn } from "./types";

const SPAN_NAMES: Record<OpenAIRequestType, string> = {
  chat: "openai.chat",
  embedding: "openai.embedding",
  response: "openai.response",
};

const STREAMING_TYPES = new Set<OpenAIRequestType>(["chat", "response"]);

function recordSpanError(span: Span, error: unknown): void {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
  span.recordException(error as Error);
}

function handleSpanError(span: Span, error: unknown): void {
  recordSpanError(span, error);
  span.end();
}

function setSpanRequestContext(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: OpenAIRequestType,
): void {
  setRequestAttributes(span, kwargs, requestType);
}

function setSpanSuccess(
  span: Span,
  response: Record<string, unknown>,
  startTime: number,
): void {
  setResponseAttributes(span, response);
  span.setAttribute("llm.response.duration", (Date.now() - startTime) / 1000);
  span.setStatus({ code: SpanStatusCode.OK });
}

function finalizeSpanSuccess(
  span: Span,
  response: Record<string, unknown>,
  startTime: number,
): void {
  setSpanSuccess(span, response, startTime);
  span.end();
}

abstract class BaseStreamHandler {
  protected completeResponse: StreamResponse = { choices: [], model: "" };
  // Assigned via defineHidden in constructor (non-enumerable to avoid circular JSON)
  protected span!: Span;
  protected startTime!: number;
  protected requestKwargs!: Record<string, unknown>;

  constructor(
    span: Span,
    startTime: number,
    requestKwargs: Record<string, unknown>,
  ) {
    defineHidden(this, "span", span);
    defineHidden(this, "startTime", startTime);
    defineHidden(this, "requestKwargs", requestKwargs);
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
  private response!: unknown;

  constructor(
    span: Span,
    response: unknown,
    startTime: number,
    requestKwargs: Record<string, unknown>,
  ) {
    super(span, startTime, requestKwargs);
    defineHidden(this, "response", response);
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

/**
 * Accumulates the chunks of an async stream. The stream itself is wrapped with
 * `wrapAsyncIterable`, so the caller keeps the SDK's own stream object
 * (`controller`, `tee()`, `toReadableStream()`), and `break` ends the span.
 */
class AsyncStreamCollector extends BaseStreamHandler {
  collect(chunk: unknown): void {
    this.processChunk(chunk);
  }

  finish(status: "ok" | "error"): void {
    if (status === "ok") {
      this.finalizeSpan(SpanStatusCode.OK);
      return;
    }
    // The error status and exception were already recorded by onError.
    this.span.setAttribute(
      "llm.response.duration",
      (Date.now() - this.startTime) / 1000,
    );
    this.span.end();
  }
}

function executeStreaming(
  span: Span,
  ctx: Context,
  kwargs: Record<string, unknown>,
  requestType: OpenAIRequestType,
  call: () => unknown,
): unknown {
  const startTime = Date.now();
  try {
    setSpanRequestContext(span, kwargs, requestType);
    const spanContext = trace.setSpan(ctx, span);
    const response = context.with(spanContext, call);

    if (isPromise(response) || isAsyncIterable(response)) {
      const collector = new AsyncStreamCollector(span, startTime, kwargs);
      return wrapResponse(response, {
        withContext: (fn) => context.with(spanContext, fn),
        onChunk: (chunk) => collector.collect(chunk),
        onError: (error) => recordSpanError(span, error),
        finalize: (status) => collector.finish(status),
      }, { deriveAPIPromise: true });
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
      // wrapPromise keeps OpenAI's APIPromise (and its .withResponse(),
      // .asResponse() and ._thenUnwrap()) instead of returning a plain Promise.
      return wrapPromise(result, {
        withContext: (fn) => fn(),
        onSuccess: (value) =>
          setSpanSuccess(span, modelAsDict(value), startTime),
        onError: (error) => recordSpanError(span, error),
        finalize: () => span.end(),
      }, { deriveAPIPromise: true });
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

    const currentContext = context.active();
    const call = () => wrapped.call(instance, ...args);
    const isStreaming = kwargs.stream === true && STREAMING_TYPES.has(requestType);

    if (isStreaming) {
      const span = tracer.startSpan(spanName, spanOpts, currentContext);
      return executeStreaming(span, currentContext, kwargs, requestType, call);
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
