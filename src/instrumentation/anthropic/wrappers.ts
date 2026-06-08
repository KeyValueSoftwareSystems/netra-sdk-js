import { context, Span, SpanKind, SpanStatusCode, trace, Tracer } from "@opentelemetry/api";
import { Logger } from "../../logger";
import { defineHidden, isPromise, modelAsDict, shouldSuppressInstrumentation } from "../utils";
import { setRequestAttributes, setResponseAttributes } from "./utils";

type AnthropicRequestType = "chat" | "beta" | "batches";

const CHAT_SPAN_NAME = "anthropic.chat";
const BETA_SPAN_NAME = "anthropic.beta";
const BATCHES_SPAN_NAME = "anthropic.batches";
const STREAM_ENABLED_REQUESTS: AnthropicRequestType[] = ["chat", "beta"];

function anthropicWrapper(
  tracer: Tracer,
  spanName: string,
  requestType: AnthropicRequestType
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
    const currentContext = context.active();
    const isStreaming = args[0]?.stream === true;
    
    const activeSpan = trace.getSpan(context.active());
    Logger.debug(`Anthropic invoke (${requestType}). Active TraceId: ${activeSpan?.spanContext().traceId}, SpanId: ${activeSpan?.spanContext().spanId}`);

    if (isStreaming && STREAM_ENABLED_REQUESTS.includes(requestType)) {
      const span = tracer.startSpan(spanName + ".create", {
        kind: SpanKind.CLIENT,
        attributes: {
          "llm.request.type": requestType,
          "llm.streaming": true
        },
      },
    currentContext);

      try {
        setRequestAttributes(span, kwargs, requestType);
        const startTime = Date.now();

        // Call the original function and get the APIPromise
        const spanContext = trace.setSpan(currentContext, span);
        const response = context.with(spanContext, () => wrapped.call(instance, ...args));

        if (isPromise(response)) {
          return (async () => {
            try {
              const stream = await response;
              // For messages.create({stream: true}), return AsyncStreamingWrapper
              // which will track streaming events and finalize the span when done
              return new AsyncStreamingWrapper(span, stream, startTime, kwargs);
            } catch (error) {
               Logger.error("netra.instrumentation.anthropic:", error);
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
             // Should usually be a promise, but just in case
             return new AsyncStreamingWrapper(span, response, startTime, kwargs);
        }

      } catch (error) {
        Logger.error("netra.instrumentation.anthropic:", error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error as Error);
        span.end();
        throw error;
      }
    }
    // Non streaming
    else {
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
            const spanContext = trace.setSpan(currentContext, span);
            const response = context.with(spanContext, () => wrapped.call(instance, ...args));
            if (isPromise(response)) {
              // Create a new promise that handles instrumentation
              const instrumentedPromise = (async () => {
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
                  Logger.error("netra.instrumentation.anthropic:", error);
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

              // Use a Proxy to preserve all methods from the original APIPromise
              // This includes withResponse(), asResponse(), etc.
              return new Proxy(instrumentedPromise, {
                get(target, prop, receiver) {
                  // Special handling for then/catch/finally - use our instrumented promise
                  if (prop === 'then' || prop === 'catch' || prop === 'finally') {
                    const value = Reflect.get(target, prop, receiver);
                    if (typeof value === 'function') {
                      return value.bind(target);
                    }
                    return value;
                  }

                  // For all other properties, first check the original response object
                  // This ensures methods like withResponse() are available
                  const responseValue = (response as any)[prop];
                  if (responseValue !== undefined) {
                    if (typeof responseValue === 'function') {
                      return responseValue.bind(response);
                    }
                    return responseValue;
                  }

                  // Fall back to the instrumented promise
                  const value = Reflect.get(target, prop, receiver);
                  if (typeof value === 'function') {
                    return value.bind(target);
                  }
                  return value;
                }
              });
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
            Logger.error("netra.instrumentation.anthropic:", error);
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
  anthropicWrapper(tracer, CHAT_SPAN_NAME, "chat");

export const betaWrapper = (tracer: Tracer) =>
  anthropicWrapper(tracer, BETA_SPAN_NAME, "beta");

export const batchesWrapper = (tracer: Tracer) =>
  anthropicWrapper(tracer, BATCHES_SPAN_NAME, "batches"); 


const WRAPPER_OWN_PROPS = new Set([
  'span', 'messageStream', 'startTime', 'requestKwargs', 'completeResponse',
  'processChunk', 'finalizeSpan', 'processEventData', 'finalizeSpanFromMessage',
]);

const EVENT_EMITTER_METHODS = new Set([
  'on', 'once', 'off', 'removeListener', 'addListener',
  'emit', 'removeAllListeners', 'listeners', 'listenerCount',
]);

const LISTENER_REGISTRATION_METHODS = new Set(['on', 'once', 'addListener']);

const COMPLETION_METHODS = new Set(['finalMessage', 'done', 'finalText']);

const TRACKED_STREAM_EVENTS = new Set(['message', 'contentBlock', 'text', 'finalMessage']);

export class MessageStreamWrapper {
  private completeResponse: Record<string, any> = {
    content: [],
    model: "",
    usage: {},
  };
  // Assigned via defineHidden in constructor (non-enumerable to avoid circular JSON)
  private span!: Span;
  private messageStream!: any;
  private startTime!: number;
  private requestKwargs!: Record<string, any>;

  constructor(span: Span, messageStream: any, startTime: number, requestKwargs: Record<string, any>) {
    defineHidden(this, "span", span);
    defineHidden(this, "messageStream", messageStream);
    defineHidden(this, "startTime", startTime);
    defineHidden(this, "requestKwargs", requestKwargs);
    // Use Proxy to delegate all properties and methods to messageStream
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === 'toJSON') {
          return () => target.completeResponse;
        }

        if (typeof prop === 'string' && WRAPPER_OWN_PROPS.has(prop)) {
          return Reflect.get(target, prop, receiver);
        }
        
        // Symbol.asyncIterator - use our custom implementation
        if (prop === Symbol.asyncIterator) {
          return target[Symbol.asyncIterator].bind(target);
        }
        
        // Event emitter methods - need special handling to maintain 'this' context
        if (typeof prop === 'string' && EVENT_EMITTER_METHODS.has(prop)) {
          const method = target.messageStream[prop];
          if (typeof method === 'function') {
            if (LISTENER_REGISTRATION_METHODS.has(prop)) {
              return function(event: string, listener: Function) {
                // Wrap the listener to track events in our span
                const wrappedListener = (...args: any[]) => {
                  target.span.addEvent(`messagestream.event.${event}`, {
                    'event.type': event,
                  });
                  
                  if (TRACKED_STREAM_EVENTS.has(event)) {
                    if (args[0]) {
                      target.processEventData(event, args[0]);
                    }
                  }
                  
                  return listener(...args);
                };
                
                return method.call(target.messageStream, event, wrappedListener);
              };
            }
            return method.bind(target.messageStream);
          }
          return method;
        }
        
        if (typeof prop === 'string' && COMPLETION_METHODS.has(prop)) {
          const method = target.messageStream[prop];
          if (typeof method === 'function') {
            return async function(...args: any[]) {
              try {
                const result = await method.call(target.messageStream, ...args);
                
                // When stream completes, finalize our span
                if (prop === 'finalMessage' || prop === 'done') {
                  target.finalizeSpanFromMessage(result);
                }
                
                return result;
              } catch (error) {
                target.finalizeSpan(SpanStatusCode.ERROR);
                throw error;
              }
            };
          }
          return method;
        }
        
        // Everything else - delegate to messageStream
        const value = target.messageStream[prop];
        if (typeof value === 'function') {
          return value.bind(target.messageStream);
        }
        return value;
      }
    });
  }

  toJSON() {
    return this.completeResponse;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    try {
      for await (const chunk of this.messageStream) {
        this.processChunk(chunk);
        yield chunk;
      }
      this.finalizeSpan(SpanStatusCode.OK);
    } catch (err) {
      Logger.error("netra.instrumentation.anthropic: Stream error", err);
      this.finalizeSpan(SpanStatusCode.ERROR);
      throw err;
    }
  }

  private processEventData(eventType: string, data: any): void {
    switch (eventType) {
      case 'message':
        // This is the message_start event data
        if (data.model) {
          this.completeResponse.model = data.model;
        }
        if (data.usage) {
          this.completeResponse.usage = data.usage;
        }
        break;
        
      case 'text':
        // Accumulate text
        if (!this.completeResponse.currentText) {
          this.completeResponse.currentText = '';
        }
        this.completeResponse.currentText += data;
        break;
        
      case 'contentBlock':
        // Track content blocks
        if (!this.completeResponse.content) {
          this.completeResponse.content = [];
        }
        this.completeResponse.content.push(data);
        break;
        
      case 'finalMessage':
        // Final message contains everything
        if (data.model) this.completeResponse.model = data.model;
        if (data.content) this.completeResponse.content = data.content;
        if (data.usage) this.completeResponse.usage = data.usage;
        break;
    }
  }

  private processChunk(chunk: any): void {
    /**
     * Anthropic streaming events look like:
     * - message_start
     * - content_block_start
     * - content_block_delta
     * - content_block_stop
     * - message_delta
     * - message_stop
     */

    switch (chunk.type) {
      case "message_start": {
        if (chunk.message?.model) {
          this.completeResponse.model = chunk.message.model;
        }
        if (chunk.message?.usage) {
          this.completeResponse.usage = chunk.message.usage;
        }
        break;
      }

      case "content_block_start": {
        if (!this.completeResponse.content) {
          this.completeResponse.content = [];
        }
        this.completeResponse.content.push({
          type: chunk.content_block.type,
          text: "",
        });
        break;
      }

      case "content_block_delta": {
        if (!this.completeResponse.content || this.completeResponse.content.length === 0) {
          this.completeResponse.content = [{ type: 'text', text: '' }];
        }
        
        const lastBlock =
          this.completeResponse.content[
            this.completeResponse.content.length - 1
          ];

        if (lastBlock && chunk.delta?.text) {
          lastBlock.text += chunk.delta.text;
        }
        break;
      }

      case "message_delta": {
        if (chunk.delta?.usage) {
          this.completeResponse.usage = {
            ...this.completeResponse.usage,
            ...chunk.delta.usage,
          };
        }
        break;
      }

      case "message_stop": {
        if (chunk.usage) {
          this.completeResponse.usage = chunk.usage;
        }
        break;
      }
    }

    this.span.addEvent("llm.content.completion.chunk", {
      "chunk.type": chunk.type,
    });
  }

  private finalizeSpanFromMessage(message: any): void {
    // Extract from final message if available
    if (message) {
      if (message.model) this.completeResponse.model = message.model;
      if (message.content) this.completeResponse.content = message.content;
      if (message.usage) this.completeResponse.usage = message.usage;
    }
    
    this.finalizeSpan(SpanStatusCode.OK);
  }

  private finalizeSpan(code: SpanStatusCode): void {
    const endTime = Date.now();
    const duration = (endTime - this.startTime) / 1000;

    setResponseAttributes(this.span, {
      model: this.completeResponse.model,
      content: this.completeResponse.content,
      usage: this.completeResponse.usage,
    });

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
          // Anthropic Stream is AsyncIterable
        if (Symbol.asyncIterator in this.response) {
          this.iterator = (this.response as AsyncIterable<unknown>)[
            Symbol.asyncIterator
          ]();
        } else if (
          typeof (this.response as AsyncIterator<unknown>).next === "function"
        ) {
          this.iterator = this.response as AsyncIterator<unknown>;
        } else {
          throw new Error("Response is not iterable");
        }
      }

      const result = await this.iterator!.next();
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
     // Reusing the same chunk processing logic as MessageStreamWrapper, but adapted for this context
     // The raw chunks from messages.create({stream:true}) are the same as what MessageStreamWrapper handles.
     
     switch (chunk.type) {
      case "message_start": {
        if (chunk.message?.model) {
          this.completeResponse.model = chunk.message.model;
        }
        if (chunk.message?.usage) {
          this.completeResponse.usage = chunk.message.usage;
        }
        break;
      }

      case "content_block_start": {
        const content = this.completeResponse.content as any[] || [];
        this.completeResponse.content = content;
        content.push({
          type: chunk.content_block.type,
          text: "",
        });
        break;
      }

      case "content_block_delta": {
        const content = this.completeResponse.content as any[] || [];
        if (content.length === 0) {
            content.push({ type: 'text', text: '' });
            this.completeResponse.content = content;
        }
        
        const lastBlock = content[content.length - 1];

        if (lastBlock && chunk.delta?.text) {
          lastBlock.text += chunk.delta.text;
        }
        break;
      }

      case "message_delta": {
        if (chunk.delta?.usage) {
            const currentUsage = this.completeResponse.usage as any || {};
          this.completeResponse.usage = {
            ...currentUsage,
            ...chunk.delta.usage,
          };
        }
        break;
      }

      case "message_stop": {
        if (chunk.usage) {
          this.completeResponse.usage = chunk.usage;
        }
        break;
      }
    }

    this.span.addEvent("llm.content.completion.chunk", {
      "chunk.type": chunk.type,
    });
  }

  private finalizeSpan(code: SpanStatusCode): void {
    const endTime = Date.now();
    const duration = (endTime - this.startTime) / 1000;
    
    // We match the format expected by setResponseAttributes
    setResponseAttributes(this.span, {
        model: this.completeResponse.model,
        content: this.completeResponse.content,
        usage: this.completeResponse.usage,
      });

    this.span.setAttribute("llm.response.duration", duration);
    this.span.setStatus({ code });
    this.span.end();
  }
}
