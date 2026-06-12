import { Tracer, Span, SpanKind, SpanStatusCode, context } from "@opentelemetry/api";
import { Logger } from "../../logger";
import { setRequestAttributes, setResponseAttributes } from "./utils";
import {
  defineHidden,
  modelAsDict,
  isPromise,
  recordTTFTAttributes,
  shouldSuppressInstrumentation,
} from "../utils";

type GroqRequestType = "chat";

const CHAT_SPAN_NAME = "groq.chat";
const STREAM_ENABLED_REQUESTS: GroqRequestType[] = ["chat"];

function groqWrapper(
  tracer: Tracer,
  spanName: string,
  requestType: GroqRequestType
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
      // IMPORTANT: Pass the active context to inherit parent span
      const currentContext = context.active();
      const span = tracer.startSpan(
        spanName,
        {
          kind: SpanKind.CLIENT,
          attributes: { "llm.request.type": requestType },
        },
        currentContext
      );

      try {
        setRequestAttributes(span, kwargs, requestType);
        const startTime = Date.now();
        const response = wrapped.call(instance, ...args);
        if (isPromise(response)) {
          return (async () => {
            try {
              const stream: any = await response;
              return new AsyncStreamingWrapper(span, stream, startTime, kwargs);
            } catch (error) {
              Logger.error("netra.instrumentation.groq:", error);
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
        Logger.error("netra.instrumentation.groq:", error);
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
                  recordTTFTAttributes(span, endTime);
                  span.setStatus({ code: SpanStatusCode.OK });
                  span.end();
                  return value;
                } catch (error) {
                  Logger.error("netra.instrumentation.groq:", error);
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
              recordTTFTAttributes(span, endTime);
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();
              return response;
            }
          } catch (error) {
            Logger.error("netra.instrumentation.groq:", error);
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

export const chatWrapper = (tracer: Tracer) =>
  groqWrapper(tracer, CHAT_SPAN_NAME, "chat");

export class StreamingWrapper implements Iterable<unknown>, Iterator<unknown> {
  private iterator: Iterator<unknown> | null = null;
  private completeResponse: Record<string, any> = { choices: [], model: "" };
  private firstTokenRecorded = false;
  // Assigned via defineHidden in constructor (non-enumerable to avoid circular JSON)
  private span!: Span;
  private response!: any;
  private startTime!: number;
  private requestKwargs!: Record<string, any>;

  constructor(span: Span, response: any, startTime: number, requestKwargs: Record<string, any>) {
    defineHidden(this, "span", span);
    defineHidden(this, "response", response);
    defineHidden(this, "startTime", startTime);
    defineHidden(this, "requestKwargs", requestKwargs);
  }

  toJSON() {
    return this.completeResponse;
  }

  [Symbol.iterator](): Iterator<unknown> {
    return this;
  }

  next(): IteratorResult<unknown> {
    try {
      const isObject = this.response && typeof this.response === "object";
      if (!isObject) {
        throw new Error("Response is not an iterable");
      }

      if (!this.iterator) {
        if (typeof this.response[Symbol.iterator] === "function") {
          this.iterator = this.response[Symbol.iterator]();
        } else if (
          typeof (this.response as Iterator<unknown>).next === "function"
        ) {
          this.iterator = this.response as Iterator<unknown>;
        } else {
          throw new Error("Response is not an iterable");
        }
      }

      if (!this.iterator) {
        throw new Error("Iterator not initialized");
      }

      const result = this.iterator.next();
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

  private processChunk(chunk: any): void {
    const chunkDict =
      typeof chunk?.toDict === "function" ? chunk.toDict() : chunk;
    const choices = this.completeResponse.choices as any[];

    if (chunkDict.model) this.completeResponse.model = chunkDict.model;

    const chunkChoices = chunkDict.choices || [];
    if (Array.isArray(chunkChoices)) {
      chunkChoices.forEach((choice: any) => {
        const index = Number(choice.index || 0);
        this.ensureChoice(index);

        const delta = choice.delta || {};
        if (delta?.content) {
          const contentPiece = String(delta.content);
          if (contentPiece && !this.firstTokenRecorded) {
            this.firstTokenRecorded = true;
            recordTTFTAttributes(this.span, Date.now());
          }
          if (!choices[index].message) {
            choices[index].message = { role: "assistant", content: "" };
          }
          choices[index].message.content += contentPiece;
        }

        if (choice.finish_reason) {
          choices[index].finish_reason = choice.finish_reason;
        }
      });
    }

    if (chunkDict.usage) this.completeResponse.usage = chunkDict.usage;

    if (chunkDict.response?.status === "completed") {
      const outputs = chunkDict.response.output || [];
      outputs.forEach((output: any) => {
        const content = output.content || [];
        content.forEach((item: any) => {
          choices.push({
            message: { role: "assistant", content: item.text || "" },
          });
        });
      });
      this.completeResponse.usage = chunkDict.response.usage || {};
    }

    this.span.addEvent("llm.content.completion.chunk");
  }

  private ensureChoice(index: number): void {
    const choices = this.completeResponse.choices as any[];
    const isChat = !!this.requestKwargs?.messages;
    while (choices.length <= index) {
      choices.push(
        isChat ? { message: { role: "assistant", content: "" } } : { text: "" }
      );
    }
  }

  private finalizeSpan(code: SpanStatusCode): void {
    const duration = (Date.now() - this.startTime) / 1000;
    this.span.setAttribute("llm.response.duration", duration);
    this.span.setStatus({ code });
    this.span.end();
  }
}

export class AsyncStreamingWrapper
  implements AsyncIterable<unknown>, AsyncIterator<unknown>
{
  private iterator: AsyncIterator<unknown> | null = null;
  private completeResponse: Record<string, unknown> = {
    choices: [],
    model: "",
  };
  private firstTokenRecorded = false;
  // Assigned via defineHidden in constructor (non-enumerable to avoid circular JSON)
  private span!: Span;
  private response!: any;
  private startTime!: number;
  private requestKwargs!: Record<string, any>;

  constructor(span: Span, response: any, startTime: number, requestKwargs: Record<string, any>) {
    defineHidden(this, "span", span);
    defineHidden(this, "response", response);
    defineHidden(this, "startTime", startTime);
    defineHidden(this, "requestKwargs", requestKwargs);
  }

  toJSON() {
    return this.completeResponse;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }

  async next(): Promise<IteratorResult<unknown>> {
    try {
      if (!this.iterator) {
        const isObject = this.response && typeof this.response === "object";
        if (!isObject) {
          throw new Error("Response is not an iterable");
        }

        if (Symbol.asyncIterator in this.response) {
          this.iterator = (this.response as AsyncIterable<unknown>)[
            Symbol.asyncIterator
          ]();
        } else if (Symbol.iterator in (this.response as any)) {
          const syncIterator = (this.response as Iterable<unknown>)[
            Symbol.iterator
          ]();
          this.iterator = {
            async next() {
              return syncIterator.next();
            },
          };
        } else if (
          typeof (this.response as AsyncIterator<unknown>).next === "function"
        ) {
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

  private processChunk(chunk: any): void {
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
      chunkChoices.forEach((choice: any) => {
        const index = Number(choice.index || 0);
        this.ensureChoice(index);
        const delta = (choice.delta || {}) as Record<string, unknown>;
        if (typeof delta === "object" && delta.content) {
          const contentPiece = String(delta.content || "");
          if (contentPiece && !this.firstTokenRecorded) {
            this.firstTokenRecorded = true;
            recordTTFTAttributes(this.span, Date.now());
          }
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
      });
    }

    if (chunkDict.usage) this.completeResponse.usage = chunkDict.usage;

    // Response API
    if ((chunkDict.response as any)?.status === "completed") {
      const response = chunkDict.response as Record<string, unknown>;
      const responseOutput = (response.output || []) as Array<
        Record<string, unknown>
      >;
      responseOutput.forEach((output: any) => {
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
        const usage = response.usage || {};
        this.completeResponse.usage = usage;
      });
    }
    this.span.addEvent("llm.content.completion.chunk");
  }

  private ensureChoice(index: number): void {
    const choices = this.completeResponse.choices as any[];
    const isChat = !!this.requestKwargs?.messages;
    while (choices.length <= index) {
      choices.push(
        isChat ? { message: { role: "assistant", content: "" } } : { text: "" }
      );
    }
  }

  private finalizeSpan(code: SpanStatusCode): void {
    const endTime = Date.now();
    const duration = (endTime - this.startTime) / 1000;
    setResponseAttributes(this.span, this.completeResponse);
    this.span.setAttribute("llm.response.duration", duration);
    this.span.setStatus({ code });
    this.span.end();
  }
}
