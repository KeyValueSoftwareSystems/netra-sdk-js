export interface AgentTrace {
  traceId: string;
  name: string;
  groupId?: string;
  metadata?: Record<string, unknown>;
  disabled?: boolean;
}

export interface AgentSpan {
  spanId: string;
  traceId: string;
  parentId?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  spanData: SpanData;
  error?: { message: string; data?: Record<string, unknown> } | null;
}

export interface SpanData {
  type: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  model?: string;
  model_config?: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number; details?: Record<string, unknown> | null };
  // HandoffSpanData
  to_agent?: string;
  from_agent?: string;
  // ResponseSpanData — _input and _response are underscore-prefixed private
  // fields in the @openai/agents SDK (validated against >=0.10.0 <1.0.0).
  // These are not part of the public API and may change without notice.
  // Callers must check for existence at runtime and degrade gracefully.
  // TODO(NET-1053): request public accessors from the Agents SDK team.
  response_id?: string;
  _input?: unknown;
  _response?: unknown;
  // GuardrailSpanData
  triggered?: boolean;
  // FunctionSpanData
  mcp_data?: string;
  // AgentSpanData
  handoffs?: string[];
  tools?: string[];
  output_type?: string;
  // CustomSpanData
  data?: Record<string, unknown>;
  // MCPListToolsSpanData
  server?: string;
  result?: string[];
}

export interface TracingProcessor {
  start?(): void;
  onTraceStart(trace: AgentTrace): Promise<void> | void;
  onTraceEnd(trace: AgentTrace): Promise<void> | void;
  onSpanStart(span: AgentSpan): Promise<void> | void;
  onSpanEnd(span: AgentSpan): Promise<void> | void;
  forceFlush(): Promise<void> | void;
  shutdown(timeout?: number): Promise<void> | void;
}

export interface InstrumentorOptions {
  tracerProvider?: { getTracer(name: string, version?: string): any };
  /** Override the `llm.system` attribute value (default: `"openai"`). */
  systemName?: string;
  /**
   * When `true` (default), replaces the OpenAI Agents SDK's default trace
   * processors so traces are sent only to Netra, when supported by the
   * installed SDK version. If the SDK does not expose the required APIs,
   * the Netra processor is appended alongside the defaults and a warning
   * is logged. When `false`, the Netra processor is always added alongside
   * the defaults (traces go to both Netra and OpenAI).
   *
   * Can also be set via the `DISABLE_NATIVE_TRACING`
   * environment variable (`"true"` / `"1"` to disable, `"false"` / `"0"` to keep).
   */
  disableNativeTracing?: boolean;
}
