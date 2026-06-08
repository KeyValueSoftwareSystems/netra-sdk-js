import { AttributeValue, Context, Span } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Logger } from "../logger";

const _PROMPT_RE = /^gen_ai\.prompts?\.(\d+)\.(role|content)$/;
const _COMPLETION_RE = /^gen_ai\.completions?\.(\d+)\.(role|content)$/;

const _TRACELOOP_PREFIX = "traceloop.";
const _NETRA_PREFIX = "netra.";

const _USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
const _USAGE_PROMPT_TOKENS = "gen_ai.usage.prompt_tokens";
const _USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
const _USAGE_COMPLETION_TOKENS = "gen_ai.usage.completion_tokens";

const NETRA_USER_INPUT = "netra.user.input";
const NETRA_USER_OUTPUT = "netra.user.output";

const NETRA_ENTITY_INPUT = "netra.entity.input";
const NETRA_ENTITY_OUTPUT = "netra.entity.output";

type SetAttributeFn = (key: string, value: AttributeValue) => Span;

function buildMessages(indexMap: Map<number, Record<string, string>>): string {
  const sorted = Array.from(indexMap.keys()).sort((a, b) => a - b);
  return JSON.stringify(sorted.map((i) => indexMap.get(i)!));
}

function extractTraceloopInput(raw: AttributeValue): string {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const payload =
      parsed && typeof parsed === "object" && "inputs" in parsed
        ? (parsed as Record<string, unknown>).inputs
        : parsed;
    return typeof payload === "string" ? payload : JSON.stringify(payload);
  } catch {
    return String(raw);
  }
}

function extractTraceloopOutput(raw: AttributeValue): string {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const payload =
      parsed && typeof parsed === "object" && "outputs" in parsed
        ? (parsed as Record<string, unknown>).outputs
        : parsed;
    return typeof payload === "string" ? payload : JSON.stringify(payload);
  } catch {
    return String(raw);
  }
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

export class SpanIOProcessor implements SpanProcessor {
  onStart(span: Span, _parentContext: Context): void {
    try {
      const attrs = (span as any).attributes ?? {};
      if (!("input" in attrs)) {
        span.setAttribute("input", "");
      }
      if (!("output" in attrs)) {
        span.setAttribute("output", "");
      }
      this._wrapSetAttribute(span);
    } catch (e) {
      Logger.error("SpanIOProcessor.onStart failed:", e);
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      const attrs = (span as any)._attributes;
      if (!attrs || typeof attrs !== "object") return;

      try {
        const userInput = attrs[NETRA_USER_INPUT];
        if (userInput) {
          attrs["input"] = userInput;
          delete attrs[NETRA_USER_INPUT];
        }
      } catch (e) {
        Logger.warn(
          "SpanIOProcessor.onEnd: could not promote netra.user.input → input",
          e,
        );
      }

      try {
        const userOutput = attrs[NETRA_USER_OUTPUT];
        if (userOutput) {
          attrs["output"] = userOutput;
          delete attrs[NETRA_USER_OUTPUT];
        }
      } catch (e) {
        Logger.warn(
          "SpanIOProcessor.onEnd: could not promote netra.user.output → output",
          e,
        );
      }
    } catch (e) {
      Logger.error(
        "SpanIOProcessor.onEnd: unexpected error during netra.user promotion",
        e,
      );
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  private _wrapSetAttribute(span: Span): void {
    const original: SetAttributeFn = span.setAttribute.bind(span);

    const prompts = new Map<number, Record<string, string>>();
    const completions = new Map<number, Record<string, string>>();

    let genAiOwnsInput = false;
    let genAiOwnsOutput = false;

    const inputIsEmpty = (): boolean =>
      isEmpty(((span as any).attributes ?? {})["input"]);

    const outputIsEmpty = (): boolean =>
      isEmpty(((span as any).attributes ?? {})["output"]);

    const patched = (key: string, value: AttributeValue): Span => {
      try {
        // 1. gen_ai.prompt(s).N.{role,content} → accumulate into input
        const promptMatch = _PROMPT_RE.exec(key);
        if (promptMatch) {
          original(key, value);
          const idx = parseInt(promptMatch[1], 10);
          const field = promptMatch[2];
          let entry = prompts.get(idx);
          if (!entry) {
            entry = {};
            prompts.set(idx, entry);
          }
          entry[field] = String(value);
          if (inputIsEmpty() || genAiOwnsInput) {
            original("input", buildMessages(prompts));
            genAiOwnsInput = true;
          }
          return span;
        }

        // 2. gen_ai.completion(s).N.{role,content} → accumulate into output
        const completionMatch = _COMPLETION_RE.exec(key);
        if (completionMatch) {
          original(key, value);
          const idx = parseInt(completionMatch[1], 10);
          const field = completionMatch[2];
          let entry = completions.get(idx);
          if (!entry) {
            entry = {};
            completions.set(idx, entry);
          }
          entry[field] = String(value);
          if (outputIsEmpty() || genAiOwnsOutput) {
            original("output", buildMessages(completions));
            genAiOwnsOutput = true;
          }
          return span;
        }

        // 3. traceloop.entity.input → extract inputs → set input
        if (key === "traceloop.entity.input") {
          if (inputIsEmpty()) {
            original("input", extractTraceloopInput(value));
          }
          return span;
        }

        // 4. traceloop.entity.output → extract outputs → set output
        if (key === "traceloop.entity.output") {
          if (outputIsEmpty()) {
            original("output", extractTraceloopOutput(value));
          }
          return span;
        }

        // 5. netra.entity.input → extract inputs → set input (LangGraph)
        if (key === NETRA_ENTITY_INPUT) {
          if (inputIsEmpty()) {
            original("input", extractTraceloopInput(value));
          }
          return span;
        }

        // 6. netra.entity.output → extract outputs → set output (LangGraph)
        if (key === NETRA_ENTITY_OUTPUT) {
          if (outputIsEmpty()) {
            original("output", extractTraceloopOutput(value));
          }
          return span;
        }

        // 7. Other traceloop.* → remap to netra.*
        if (key.startsWith(_TRACELOOP_PREFIX)) {
          const newKey = _NETRA_PREFIX + key.slice(_TRACELOOP_PREFIX.length);
          return original(newKey, value);
        }

        // 8. gen_ai.usage token aliasing
        if (key === _USAGE_INPUT_TOKENS) {
          return original(_USAGE_PROMPT_TOKENS, value);
        }
        if (key === _USAGE_OUTPUT_TOKENS) {
          return original(_USAGE_COMPLETION_TOKENS, value);
        }

        // 9. Pass through
        return original(key, value);
      } catch (e) {
        Logger.debug(`SpanIOProcessor: error processing key=${key}`, e);
        try {
          return original(key, value);
        } catch {
          return span;
        }
      }
    };

    (span as any).setAttribute = patched;
  }
}
