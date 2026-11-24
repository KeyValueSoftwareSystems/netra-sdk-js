/**
 * JS-SEC-004 / JS-SEC-005 regression tests: `traceContent: false` keeps
 * function I/O, prompts and completions out of spans, and tool definitions
 * never carry credentials.
 */
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { workflow } from "../decorators";
import { REDACTED, sanitizeToolsForTrace, setRequestAttributes } from "../instrumentation/utils";
import { SessionManager } from "../session-manager";
import { SpanIOProcessor } from "./span-io-processor";

const MCP_TOOLS = [
  {
    type: "mcp",
    server_label: "gh",
    server_url: "https://mcp.example",
    headers: { Authorization: "Bearer ghp_TESTTOKEN123" },
  },
  { type: "mcp", server_label: "crm", connector_id: "connector_x", authorization: "oauth-TESTTOKEN456" },
  { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
];

describe("traceContent: false", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    // No constructor flag: SpanIOProcessor reads the current setting per write.
    spanProcessors: [new SpanIOProcessor(), new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("test");
  const allAttributes = () =>
    JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes));

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });

  afterAll(async () => {
    context.disable();
    await provider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "false");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("decorated functions record neither arguments nor return value", async () => {
    // The decorator uses the global tracer provider; route it to ours.
    const { trace } = await import("@opentelemetry/api");
    trace.setGlobalTracerProvider(provider);
    try {
      const handle = workflow(async function handle(note: string) {
        return `diagnosis for ${note}`;
      });
      await handle("SECRET-PHI-123");
    } finally {
      trace.disable();
    }

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    expect(allAttributes()).not.toContain("SECRET");
  });

  it("drops prompts, completions, entity I/O and explicit setInput/setOutput", () => {
    tracer.startActiveSpan("llm", (span) => {
      span.setAttribute("gen_ai.prompt.0.role", "user");
      span.setAttribute("gen_ai.prompt.0.content", "SECRET prompt");
      span.setAttribute("gen_ai.completion.0.content", "SECRET completion");
      span.setAttribute("gen_ai.completion.0.tool_calls.0.arguments", '{"ssn":"SECRET"}');
      span.setAttribute("netra.entity.input", '{"inputs":"SECRET"}');
      span.setAttribute("traceloop.entity.output", '{"outputs":"SECRET"}');
      span.setAttribute("netra.mcp.data", "SECRET");
      // OTel GenAI semconv keys written by Traceloop's LangChain handler
      span.setAttribute("gen_ai.input.messages", '[{"role":"user","parts":[{"content":"SECRET"}]}]');
      span.setAttribute("gen_ai.output.messages", '[{"role":"assistant","parts":[{"content":"SECRET"}]}]');
      span.setAttribute("gen_ai.system_instructions", "SECRET instructions");
      span.setAttribute("gen_ai.tool.call.arguments", '{"ssn":"SECRET"}');
      span.setAttribute("gen_ai.tool.call.result", "SECRET result");
      span.setAttribute("gen_ai.tool.definitions", '[{"name":"x","headers":{"a":"SECRET"}}]');
      span.setAttribute("gen_ai.request.model", "gpt-x");
      span.setAttribute("gen_ai.completion.0.finish_reason", "stop");
      SessionManager.setInput("SECRET input");
      SessionManager.setOutput("SECRET output");
      SessionManager.addConversation("input" as any, "user", "SECRET conversation");
      span.end();
    });

    const [span] = exporter.getFinishedSpans();
    expect(allAttributes()).not.toContain("SECRET");
    // Metadata is kept.
    expect(span.attributes["gen_ai.request.model"]).toBe("gpt-x");
    expect(span.attributes["gen_ai.completion.0.finish_reason"]).toBe("stop");
  });

  it("records content again when traceContent is on", () => {
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "true");
    tracer.startActiveSpan("llm", (span) => {
      span.setAttribute("gen_ai.prompt.0.role", "user");
      span.setAttribute("gen_ai.prompt.0.content", "visible prompt");
      span.end();
    });
    expect(exporter.getFinishedSpans()[0].attributes["input"]).toContain("visible prompt");
  });

  it("a constructor flag overrides the environment", () => {
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "true");
    const exp = new InMemorySpanExporter();
    const p = new BasicTracerProvider({
      spanProcessors: [new SpanIOProcessor(false), new SimpleSpanProcessor(exp)],
    });
    const span = p.getTracer("t").startSpan("x");
    span.setAttribute("gen_ai.prompt.0.content", "SECRET");
    span.end();
    expect(JSON.stringify(exp.getFinishedSpans()[0].attributes)).not.toContain("SECRET");
  });
});

describe("tool definitions (JS-SEC-005)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function recordedTools(): string {
    const attrs: Record<string, unknown> = {};
    const span: any = {
      isRecording: () => true,
      setAttribute: (k: string, v: unknown) => {
        attrs[k] = v;
      },
    };
    setRequestAttributes(span, { model: "gpt-x", input: "hi", tools: MCP_TOOLS }, "response", "openai");
    return String(attrs["tools"]);
  }

  it("redacts credentials when content tracing is on", () => {
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "true");
    const tools = recordedTools();
    expect(tools).not.toContain("TESTTOKEN");
    expect(tools).toContain(REDACTED);
    // Non-secret definition details are kept.
    expect(tools).toContain("https://mcp.example");
    expect(tools).toContain('"parameters"');
  });

  it("keeps only type and name when content tracing is off", () => {
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "false");
    expect(JSON.parse(recordedTools())).toEqual([
      { type: "mcp", name: "gh" },
      { type: "mcp", name: "crm" },
      { type: "function", name: "lookup" },
    ]);
  });

  it("redacts nested and differently-cased secret keys and survives cycles", () => {
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "true");
    const tool: any = {
      type: "x",
      config: { "Api-Key": "k1", nested: [{ access_token: "k2", authorization_token: "k3" }] },
    };
    tool.self = tool;
    const out = JSON.stringify(sanitizeToolsForTrace([tool]));
    expect(out).not.toMatch(/k1|k2|k3/);
  });

  it("redacts keys that end in a secret name, not only exact matches", () => {
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "true");
    const out = JSON.stringify(
      sanitizeToolsForTrace([
        {
          type: "mcp",
          refresh_token: "s1",
          secret_key: "s2",
          client_secret: "s3",
          "x-api-key": "s4",
          extra_headers: { "X-Custom": "s5" },
          db_password: "s6",
          max_tokens: 100,
        },
      ]),
    );
    expect(out).not.toMatch(/s[1-6]"/);
    expect(out).toContain('"max_tokens":100');
  });

  it("keeps only the origin of URL values, dropping secrets in path, query and userinfo", () => {
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "true");
    const [tool] = sanitizeToolsForTrace([
      {
        type: "mcp",
        server_url: "https://mcp.zapier.com/api/mcp/s/SECRETPATH/mcp",
        endpoint: "https://api.example.com/v1?api_key=SECRETQUERY",
        callback_uri: "https://user:SECRETPASS@hooks.example.com/cb",
        bad_url: "not a url SECRETRAW",
      },
    ]) as Record<string, unknown>[];
    expect(tool.server_url).toBe("https://mcp.zapier.com");
    expect(tool.endpoint).toBe("https://api.example.com");
    expect(tool.callback_uri).toBe("https://hooks.example.com");
    expect(tool.bad_url).toBe(REDACTED);
    expect(JSON.stringify(tool)).not.toContain("SECRET");
  });

  it("keeps JSON-schema argument definitions whose names look like secrets", () => {
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "true");
    const [tool] = sanitizeToolsForTrace([
      {
        type: "function",
        function: {
          name: "login",
          parameters: {
            type: "object",
            properties: {
              api_key: { type: "string", description: "The user's key" },
              token: { type: "string" },
            },
          },
        },
      },
    ]) as any[];
    expect(tool.function.parameters.properties.api_key).toEqual({
      type: "string",
      description: "The user's key",
    });
    expect(tool.function.parameters.properties.token).toEqual({ type: "string" });
  });

  it("still redacts a credential value stored under a properties object", () => {
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "true");
    const out = JSON.stringify(
      sanitizeToolsForTrace([{ type: "mcp", properties: { api_key: "sk-live-SECRET", region: "eu" } }]),
    );
    expect(out).not.toContain("SECRET");
    expect(out).toContain('"region":"eu"');
  });
});
