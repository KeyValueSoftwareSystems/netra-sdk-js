/**
 * Audit finding INST-2: graph.stream() yielded `{ done, value }` objects
 * instead of chunks, and the workflow context leaked into the caller through
 * AsyncLocalStorage.enterWith(), so later graph calls in the same request were
 * not traced. These run a real LangGraph graph.
 */
import { context, trace } from "@opentelemetry/api";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setupTracing } from "../../__fixtures__/llm-test-utils";
import { NetraLanggraphInstrumentor } from "./index";

const WORKFLOW = "Langgraph.workflow";

const State = Annotation.Root({
  question: Annotation<string>,
  answer: Annotation<string>,
});

async function collect(iterable: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("LangGraph instrumentation", () => {
  let tracing: ReturnType<typeof setupTracing>;
  const instrumentor = new NetraLanggraphInstrumentor();
  // Span id active inside the node on each run.
  let nodeSpanIds: Array<string | undefined>;

  const graph = new StateGraph(State)
    .addNode("respond", async (state) => {
      nodeSpanIds.push(trace.getSpan(context.active())?.spanContext().spanId);
      return { answer: `answer to ${state.question}` };
    })
    .addEdge(START, "respond")
    .addEdge("respond", END)
    .compile();

  beforeAll(async () => {
    tracing = setupTracing();
    await instrumentor.instrument({ tracerProvider: tracing.provider });
  });

  afterAll(async () => {
    await instrumentor.uninstrument();
    await tracing.teardown();
  });

  beforeEach(() => {
    tracing.exporter.reset();
    nodeSpanIds = [];
  });

  it("stream() yields LangGraph's own chunks", async () => {
    const chunks = await collect(await graph.stream({ question: "2+2" }));

    expect(chunks).toEqual([{ respond: { answer: "answer to 2+2" } }]);
    const [span] = tracing.spans(WORKFLOW);
    expect(span.attributes["netra.entity.output"]).toContain("answer to 2+2");
  });

  it("stream() returns LangGraph's stream, so getReader() still works", async () => {
    const stream: any = await graph.stream({ question: "2+2" });
    const reader = stream.getReader();

    expect((await reader.read()).value).toEqual({ respond: { answer: "answer to 2+2" } });
    await reader.cancel();
  });

  it("nodes run inside the workflow span for both stream() and invoke()", async () => {
    await collect(await graph.stream({ question: "a" }));
    await graph.invoke({ question: "b" });

    const workflowIds = tracing.spans(WORKFLOW).map((s) => s.spanContext().spanId);
    expect(workflowIds).toHaveLength(2);
    expect(nodeSpanIds).toEqual(workflowIds);
  });

  it("traces every graph call in the same async flow", async () => {
    await collect(await graph.stream({ question: "first" }));
    await collect(await graph.stream({ question: "second" }));
    for (const question of ["x", "y", "z"]) await graph.invoke({ question });

    expect(tracing.spans(WORKFLOW)).toHaveLength(5);
  });

  it("leaves the caller's context as it was", async () => {
    const tracer = tracing.provider.getTracer("test");
    await tracer.startActiveSpan("request", async (request) => {
      await graph.invoke({ question: "a" });
      await collect(await graph.stream({ question: "b" }));

      expect(trace.getSpan(context.active())).toBe(request);
      request.end();
    });

    const requestId = tracing.spans("request")[0].spanContext().spanId;
    for (const span of tracing.spans(WORKFLOW)) {
      expect(span.parentSpanContext?.spanId).toBe(requestId);
    }
  });
});
