# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`Netra.withSession()` and `Netra.clearSession()`**: `Netra.withSession({ userId, sessionId, tenantId }, fn)` applies the identity to every span started inside `fn`. `Netra.clearSession()` clears the identity set for the current request or async flow.

### Changed

- **Identity Stays in Your Process**: `setSessionId`, `setUserId` and `setTenantId` no longer write W3C baggage, so the values are no longer sent in the `baggage` header of every outgoing HTTP and `fetch` request, for example to AI providers (JS-SEC-002). The values apply to the current request or async flow only. A value set in one request no longer shows up on later requests that set none (JS-SEC-003). Calling a setter before `Netra.init()`, or with a context manager other than Netra's registered first, now prints a one-time warning, and the value applies only to the active span.
- **Incoming Baggage Is No Longer Trusted**: `user_id`, `session_id`, `tenant_id` and `custom_keys` in an incoming `baggage` header no longer set the identity or custom attributes of the request's spans. `netra.*` baggage keys are dropped on incoming and outgoing requests, so a caller can no longer hide its requests by sending `netra.local_blocked_spans` (JS-SEC-001). `withBlockedSpansLocal` and `startSpan`'s `blockedSpans` still work, and their patterns are no longer sent to downstream services.
- **`traceContent: false` Applies Everywhere**: Function arguments and return values from `@workflow`, `@agent`, `@task` and `@span`, LangGraph graph state, node and tool input and output, and OpenAI Agents prompts, instructions, completions, tool input and output, MCP data and custom span data are no longer recorded when content tracing is off. Explicit `setInput`, `setOutput`, `setRootInput`, `setRootOutput` and `addConversation` calls are also dropped. Content keys are filtered centrally, so no integration can record them. This includes the OpenTelemetry GenAI keys (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`/`result`) that Traceloop's LangChain integration kept writing with content off (JS-SEC-004).
- **Tool Definitions Are Redacted**: Credentials in tool definitions, such as remote MCP `headers`, connector `authorization` and `authorization_token`, are recorded as `[REDACTED]`. With content tracing off, only each tool's type and name are recorded (JS-SEC-005).
- **Database Query Parameters Are Opt-In**: TypeORM spans no longer record query parameter values such as emails and reset tokens. They record `db.statement.parameters.count` instead. Set `NETRA_TRACE_DB_PARAMETERS=true` to record the values; it takes effect only while content capture is on (JS-SEC-016).
- **The API Key Only Goes to Netra**: Whether an endpoint belongs to Netra is now decided by its host (`getnetra.ai` and its subdomains), not by `getnetra` appearing anywhere in the URL. When the endpoint comes only from `OTEL_EXPORTER_OTLP_ENDPOINT` and is not a Netra host, `NETRA_API_KEY` is no longer sent to it, by the span exporter or the API clients, and a warning says so. An explicit `NETRA_OTLP_ENDPOINT`, including a self-hosted Netra, still receives the key (JS-SEC-006).
- **No Secrets or Shared Settings in `process.env`**: `Netra.init()` no longer copies the API key, the export headers or the endpoint into `TRACELOOP_API_KEY`, `TRACELOOP_HEADERS` and `TRACELOOP_BASE_URL`, which every child process inherited, and no longer overwrites `TRACELOOP_TRACE_CONTENT`. `OTEL_RESOURCE_ATTRIBUTES` is set only while the tracer starts and is then restored. The `headers` object passed to `Netra.init()` is no longer modified (JS-SEC-007, JS-SEC-022).
- **Span Uploads Are Bounded and Retried**: Each batch has a time limit of 10 s, retries included, set with `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` or `OTEL_EXPORTER_OTLP_TIMEOUT`. Connection errors, timeouts, 408, 429 and 502/503/504 are retried up to 5 times with jittered backoff, honouring `Retry-After`. At most 16 uploads run at once; further batches wait in a queue of up to 1,024 and are dropped only when it is full. Only the first 64 KiB of an error response is read (JS-MEM-002, JS-PERF-006).
- **Only `QUOTA_EXCEEDED` Pauses Uploads**: The 15-minute export pause now starts only when the backend reports exhausted quota (`errorCode: "QUOTA_EXCEEDED"`, or a "usage quota exceeded" message). An ordinary 429 rate limit is retried instead. Trace ids remembered during a pause now expire after 30 minutes, at most 10,000 are kept, and they are cleared on shutdown (JS-MEM-004).
- **Faster Startup**: The Traceloop SDK and its dependency tree now load on the first `Netra.init()` instead of when `netra-sdk` is imported. Loading the package took about 610 ms and now takes about 140 ms (JS-PERF-007).
- **Nothing Global Until `Netra.init()`**: Importing the SDK no longer registers a global propagator. Netra's propagator is registered when tracing starts. If the app registered its own `TracerProvider` first, Netra now prints a warning and leaves that provider alone, instead of adding its processors to it and rewriting the app's own spans (JS-SEC-011).
- **Lazy Query Builders Are Not Run Early**: A traced function that returns a thenable that is not a real Promise, such as a Knex, Prisma or Mongoose query builder, gets it back untouched; the SDK no longer calls `then()`, which ran the query early and outside the caller's transaction. Such spans end without an output (JS-SEC-010).
- **Scrubbing Covers More and Matches Keys Exactly**: With `enableScrubbing`, attributes passed when a span starts, span events (including recorded exceptions), status messages and span names are scrubbed too. Sensitive attribute names are matched by name parts, including camelCase parts, so `dbPassword`, `authToken`, `openaiApiKey` and `encryption_key` are scrubbed while `netra.span.type`, `gen_ai.request.max_tokens` and `cache.key` are kept. A `key` or `token` part counts as sensitive when a word such as `api`, `secret`, `private`, `access`, `auth`, `refresh` or `signing` comes before it. The email pattern no longer backtracks on crafted input or long base64 and hex values, which could block the app (JS-SEC-009, JS-SEC-021).
- **Per-Chunk Stream Events Only in Debug Mode**: OpenAI, Groq and Mistral streams record an `llm.content.completion.chunk` event per chunk only in debug mode, as Anthropic and Google GenAI already did (JS-PERF-014).
- **Bounded Simulations and Evaluations**: A simulated conversation stops after 100 turns (`NETRA_SIMULATION_MAX_TURNS`). Simulation attachments must use https, may not point to private or local addresses, follow at most 3 redirects and are limited to 50 MiB (`NETRA_SIMULATION_MAX_FILE_BYTES`). Evaluator runs share the test run's `maxConcurrency` instead of all starting at once. Session-stats iteration stops when a page reports more results without a new cursor (JS-SEC-017, JS-PERF-010, JS-PERF-011).
- **More Robust API Clients**: Netra API calls have one time limit covering the response body, read at most 10 MiB, retry GET requests on network errors, 429 and 502/503/504, and follow redirects only within the API's own origin, so `x-api-key` is never sent to another host (JS-PERF-009, JS-SEC-017).
- **Smaller Package and Dependency Upkeep**: The published package no longer includes source maps (765 kB to 255 kB packed). A CI workflow type-checks, tests and builds every change, checks that `require("netra-sdk")` works on Node 18, 20.18 and 22.11, and reports `npm audit` results; Dependabot keeps dependencies and actions current. `follow-redirects` and `zod` are updated past their advisories (JS-SEC-020, JS-SEC-026).

### Fixed

- **Memory Leak Behind Gateways and Service Meshes**: Every request that arrived with a `traceparent` header and made an LLM call left a trace id in memory that was never freed. The first span of a trace in this process now counts as its root even when its parent is remote. As a result, `netra.trace.llm.call` and `setRootInput`/`setRootOutput` now also work for such requests (JS-MEM-001).
- **No Crash or API Key Leak Without an Endpoint**: Without `NETRA_OTLP_ENDPOINT`, the underlying Traceloop SDK fetched prompts from `api.traceloop.com` in the background, sending the Netra API key there. If the host could not be reached, the app crashed with an unhandled rejection. This prompt sync is now off (JS-PERF-001).
- **CommonJS on Node 18, 20 < 20.19 and 22 < 22.12**: `require("netra-sdk")` threw `ERR_REQUIRE_ESM` because of the ESM-only `p-limit` dependency. It is replaced by an internal concurrency limiter (JS-PERF-004).
- **Concurrent Requests No Longer Share Workflow, Agent and Task Names**: Decorated functions pushed their names onto one process-wide stack, so under concurrency spans got another request's `netra.workflow.name`, `netra.agent.name` and `netra.task.name`. Each decorated call now runs in its own entity scope (JS-SEC-018).
- **Unfinished Spans No Longer Stay in Memory**: The span-name registry is kept per entity scope instead of in a module global, and at most 10,000 root spans are tracked, so spans that never end are no longer held for the life of the process (JS-MEM-005).
- **Scripts Exit When Netra Hangs**: When the flush in `Netra.shutdown()` does not finish within 5 s, uploads still in flight are aborted and batches still waiting are dropped without being sent, so an endpoint that accepts connections but never answers no longer keeps a finished script, job or serverless handler running (JS-PERF-003).
- **Streams Read Other Ways End Their Span**: The span of an Anthropic `create({ stream: true })` call now ends when the stream comes from `.withResponse()`, and when the raw response is read through `.asResponse()`. A LangGraph `stream()` read with `getReader()`, or cancelled, ends its span too. A stream the app drops without reading or cancelling has its span ended once the stream is garbage-collected. These spans were never exported and stayed in memory (JS-MEM-003).
- **`%` in `OTEL_RESOURCE_ATTRIBUTES` No Longer Breaks `init()`**: A raw `%`, as in `team=R%D`, made `Netra.init()` throw `URIError`. The value is now kept as written (JS-PERF-008).
- **Long Chat Histories No Longer Block the App**: Each prompt or completion message used to rebuild and re-stringify the whole history; a 1,000-message prompt took about 2.7 s and over 3,700 `JSON.stringify` calls. The history is now rebuilt once, and each stored message is cut to `NETRA_SPAN_ATTRIBUTE_MAX_SIZE` (JS-PERF-002, JS-MEM-006).
- **Large Inputs Are Not Serialized in Full**: Traced function arguments and results, and LangGraph state, are serialized up to twice the attribute size limit instead of in full before truncation. Buffers and typed arrays are recorded as `[Buffer N bytes]` instead of an array with one number per byte (JS-MEM-007, JS-PERF-012).
- **Recording Never Breaks the App's Call**: LangGraph state, Groq and Mistral requests, and request `reasoning` settings that cannot be turned into JSON (circular, `BigInt`) no longer make the call fail (JS-PERF-005).
- **Re-initializing Replaces Netra's Processors**: Each `Netra.init()` after `Netra.shutdown()` added another full set of span processors. The previous set is now replaced. The `LocalFilteringSpanProcessor` registered on the provider is now the one configured with `blockedSpans` and shared with the exporter, so blocked spans' children are reparented as intended (JS-MEM-008).
- **Bounded Streamed Choices**: A streamed `choice.index` of 128 or more, or an invalid one, is ignored instead of growing the choices array up to it (JS-MEM-009).
- **Google GenAI Chat History Read Only With Content Tracing**: `Chat.getHistory()`, which may copy the whole history, is no longer called when content tracing is off (JS-PERF-013).
- **Prompt Cache**: Names and labels containing `:` no longer share a cache entry, and concurrent `getPrompt` calls for a missing entry share one request (JS-SEC-023, JS-PERF-015).
- **Safe Export Error Logs**: Error text from the trace endpoint is capped at 200 characters and its control characters are escaped, so a collector cannot inject or flood log lines (JS-SEC-024).
- **Fewer Side Effects in Other Libraries**: The filter that removes Traceloop's LangChain callback is installed only when Traceloop patched LangChain, and the Mistral instrumentation no longer passes the app's `MISTRAL_API_KEY` to the throwaway client it builds to find constructors (JS-SEC-025).
- **Evaluation Session ID**: `Evaluation.runTestSuite` reads the session id from the value set with `Netra.setSessionId()`/`Netra.withSession()`, now that session values are no longer kept in baggage.

## [1.12.2] - 2026-11-04

### Changed

- **Problems You Have to Fix Are Logged Outside Debug Mode**: Messages that say the app is misconfigured or a call failed are now printed whether or not debug mode is on, through `console.warn` or `console.error` with the `[Netra]` prefix. They cover: `NETRA_OTLP_ENDPOINT` not set (spans fall back to the console exporter and Netra API calls are disabled), `NETRA_API_KEY` missing for a Netra endpoint, span batches that were dropped (debug mode only in `1.12.1`), an unparsable `NETRA_RESOURCE_ATTRS`, `rootInstruments=ALL` contradicted by `blockInstruments=ALL`, `Netra.init()` called more than once, invalid arguments to public methods (`setSessionId`, `setUserId`, `setTenantId`, and the dashboard, evaluation, simulation, usage, prompts and models clients), and failed calls to the Netra APIs. A missing endpoint used to print `NETRA_OTLP_ENDPOINT is required for API calls` once per API client; it is now one message at init.
- **Internal Errors Print Only in Debug Mode**: Before, every internal error was printed with `console.error`, even with debug mode off. Errors the developer cannot act on, such as a failure while uninstrumenting or flushing during `shutdown()`, are now printed only in debug mode (`debugMode: true` or `NETRA_DEBUG=true`). Problems the developer has to fix are still printed, as described above.

### Fixed

- **No False Missing-API-Key Error When the Key Is Sent as a Header**: The missing `NETRA_API_KEY` error was printed even when the key was already passed as an `x-api-key` header through `headers` or `NETRA_HEADERS`. Such a header now counts as a key; the header name is matched case-insensitively.

## [1.12.1] - 2026-11-02

### Changed

- **Protobuf Span Export**: The OTLP exporter now sends spans as Protobuf (`application/x-protobuf`) instead of JSON, which makes each export request smaller.

### Fixed

- **Export Failures Are Logged**: In debug mode (`debugMode: true` or `NETRA_DEBUG=true`), a batch that is not exported now logs a warning. The warning gives the HTTP status, the backend's error message (or the start of the response body), and the number and size of the dropped spans. A `413 Payload Too Large` response also suggests lowering `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` or reducing large span attributes. Network errors that return no response (connection refused, DNS, TLS, socket reset) are logged the same way. Failed batches are still not retried. Before this change, they were dropped without any log.

## [1.12.0] - 2026-10-29

### Added

- **`registerShutdownHooks` Option**: `Netra.init({ registerShutdownHooks: false })` skips the SDK's `SIGINT`, `SIGTERM`, `uncaughtException` and `beforeExit` hooks, so the application can manage shutdown itself and call `Netra.shutdown()`. Defaults to `true`. A running simulation still registers short-lived hooks of its own so an interrupted run is marked `failed`.

### Changed

- **Shutdown Hooks No Longer Exit the Process**: The signal and crash hooks flush pending spans (for up to 5 seconds) and then hand control back instead of calling `process.exit()`. An application that handles the event itself stays in control and is no longer cut off mid-drain. Otherwise Node's default applies: `SIGTERM`/`SIGINT` now end the process by that signal (exit code 143/130) instead of exit code 0, and an uncaught exception exits with code 1. If the application has its own `uncaughtException` handler, the SDK leaves crashes to it and does not flush.
- **Signal Hand-Back**: If the application handles a signal, removes its handler and re-sends the same signal (as NestJS `enableShutdownHooks()` does), the SDK finishes its flush before the process exits. A different signal, or the same signal sent again after that, exits immediately. Because a re-sent signal cannot be told apart from a user pressing Ctrl+C twice, an application whose handler removes itself (e.g. `process.once`) waits for the flush on a second identical signal.
- **`Netra.shutdown()` Lifecycle**: Repeated or overlapping calls share one shutdown, and the returned promise also waits for other SDK exit work, such as a simulation marking its run `failed`. `Netra.init()` waits for an in-flight shutdown before re-initializing. `Netra.shutdown()` now flushes the tracer provider without shutting it down, so a later `Netra.init()` in the same process keeps exporting spans.
- **LangGraph Uses the Application's `@langchain/core`**: `@langchain/core` is no longer bundled. The LangGraph instrumentation builds on the application's own copy, declared as an optional peer dependency (`>=1.0.0 <2.0.0`), and is skipped with a warning when it is not installed. `@langchain/langgraph` is now an optional peer dependency.
- **CommonJS Type Declarations**: `require` consumers now resolve their own declarations (`dist/index.d.cts`), so TypeScript picks the correct types for both `import` and `require` under `node16`/`nodenext` module resolution.
- **Dependencies**: `@traceloop/instrumentation-langchain` (`^0.27.0`) is now a direct dependency. `@langchain/ollama`, `@opentelemetry/instrumentation-http`, `@opentelemetry/instrumentation-express` and `@opentelemetry/instrumentation-undici` are no longer declared as peer dependencies; the HTTP, Express and undici instrumentations are still enabled when those packages are installed.

### Fixed

- **Spans Flushed on Shutdown**: `Netra.shutdown()` and the shutdown hooks now flush the real tracer provider. Previously they looked for `forceFlush()` on OpenTelemetry's global proxy provider, which does not have one, so spans still buffered when the process stopped were lost.
- **Faster Natural Exit**: A process that finishes on its own no longer stays alive for up to 5 seconds after the flush completes.
- **No Hang When a Signal Listener Is Removed**: If a signal listener that existed when the SDK installed its hooks (for example a transient `signal-exit` hook) is removed before the signal arrives, the SDK now re-raises the signal instead of leaving the process running until `SIGKILL`.
- **Simulation Status on Interruption**: Marking an interrupted simulation run `failed` is coordinated with the span flush, so the status update is no longer cut short. A crash or rejection that the application handles and recovers from no longer marks a healthy run `failed` or disarms the SDK's hooks.

### Security

- **API Path Encoding**: IDs interpolated into API paths (sessions, tenants, traces, spans, datasets, evaluation runs and simulation items) are percent-encoded as a single path segment, so a value containing `/`, `?`, `#` or `%` can no longer change which endpoint is called. Empty, `.` and `..` values are rejected: the call fails and an error is logged.
- **Cache Isolation**: The prompts and models caches store and return deep copies, so mutating a returned object (for example, appending messages to a prompt) no longer changes what later callers receive.

## [1.11.0] - 2026-10-27

### Added

- **OpenAI Cache-Write TTL Breakdown**: OpenAI usage payloads that split cache writes by TTL (`cache_write_tokens_details.ttl_30m_tokens` / `ttl_12h_tokens` under `prompt_tokens_details` or `input_tokens_details`) are now recorded as `gen_ai.usage.cache_creation_input_tokens_30m` and `gen_ai.usage.cache_creation_input_tokens_12h`, since each tier is billed at a different rate. Captured by both the OpenAI and OpenAI Agents instrumentations (span usage and Responses API usage). A tier reported as `0` is recorded; a missing or non-numeric tier is skipped. Exposed as `SpanAttributes.LLM_USAGE_CACHE_CREATION_INPUT_TOKENS_30M` and `SpanAttributes.LLM_USAGE_CACHE_CREATION_INPUT_TOKENS_12H`.

## [1.10.1] - 2026-10-07

### Changed

- **Dependency Updates**: Bumped runtime dependencies — `@opentelemetry/core` to `^2.11.0`, `@opentelemetry/otlp-transformer` to `^0.222.0`, `@opentelemetry/instrumentation-undici` to `^0.32.0`, `@traceloop/node-server-sdk` to `^0.27.0`, and `axios` to `^1.20.0`. The `@opentelemetry/instrumentation-undici` peer dependency range moved from `^0.6.0` to `^0.32.0`, so applications that install it directly need a compatible version.

## [1.10.0] - 2026-09-21

### Added

- **Models API**: New `Netra.models` client. `Netra.models.getModelPricing({ name?, useCache?, cacheTtl? })` fetches model pricing from `/sdk/models` (optional `name` filter), returning `ModelPricing[]` or `null` on failure. Request timeout is configurable via `NETRA_MODELS_TIMEOUT` (default 10s). New exported surface: `Models`, `MODEL_PRICING_CACHE_TTL_SECONDS`, and the types `ModelPricing`, `ModelPrice`, `GetModelPricingParams`.
- **Opt-in Prompt Caching**: `Netra.prompts.getPrompt()` accepts `useCache` and `cacheTtl`. When `useCache` is true, responses are served from an in-memory TTL cache keyed by prompt name and label; default TTL is `PROMPT_CACHE_TTL_SECONDS` (60 seconds). Caching stays off unless `useCache` is set, so existing callers are unaffected.
- **Opt-in Model Pricing Caching**: `getModelPricing()` uses the same opt-in pattern, with default TTL `MODEL_PRICING_CACHE_TTL_SECONDS` (300 seconds). Only successful responses are cached; `null` results are not.
- **Cache Lifecycle**: `Netra.shutdown()` clears the prompts and models in-memory caches, and `clearCache()` is available on each client for manual invalidation.
- **Exported Cache Constants**: `PROMPT_CACHE_TTL_SECONDS` and `MODEL_PRICING_CACHE_TTL_SECONDS` are public exports, so callers can reason about default TTLs without hardcoding them.

### Changed

- **Test Runner**: `npm test` now runs `vitest run` (previously a placeholder that exited 1), with unit coverage for the TTL cache, the prompts and models clients, and cache clearing on shutdown. Dev-only change — the published package still ships `dist/` alone.

## [1.9.0] - 2026-08-23

### Added

- **Session Details API**: Added `Netra.dashboard.getSessionDetails(sessionId)`, returning a per-trace breakdown for a session — start/end times, latency, input/output, token counts (prompt, completion, cached, cache-creation, total), the matching cost breakdown, models used, and per-tool call counts. Returns `null` and logs an error when `sessionId` is empty. New exported types: `SessionDetailsResponse`, `SessionDetailsTrace`, `SessionDetailsToolCall`.
- **Trace Origin Label**: Root spans created by evaluation test runs (`Evaluation`) and multi-turn simulations (`Simulation`) now carry `netra.trace.origin = "evaluation"`, so the backend can distinguish them from normal production traces and exclude them from online evaluation, auto-evaluation, and insights enrichment. Exposed as `Config.TRACE_ORIGIN_KEY` and `Config.TRACE_ORIGIN_EVALUATION`.
- **OpenAI Cache-Write Tokens**: `setUsageAttributes` now falls back to `prompt_tokens_details.cache_write_tokens` (or `input_tokens_details.cache_write_tokens`) when the Anthropic-style `cache_creation_input_tokens` is absent, so cache-write usage is captured for OpenAI-shaped usage payloads instead of being dropped.

### Fixed

- **`db.statement` Mapped to Span Input**: `SpanIOProcessor` now maps `db.statement` onto the span's `input` attribute for DB instrumentations (TypeORM and other OTel dbapi-style instrumentations), which previously produced spans with empty Input/Output in the UI even when SQL was present. `db.statement` itself is preserved, `input` is written only when it is currently empty and not locked by root/user ownership, and `output` is never populated from DB attributes since query parameters and result rows are user data.

### Removed

- **`enableRootSpan` Configuration** (**breaking**): Removed the `enableRootSpan` init option, the `NETRA_ENABLE_ROOT_SPAN` environment variable, and the `Netra.runWithRootSpan()` helper. OpenTelemetry for JavaScript has no equivalent of Python's persistent `context.attach()` — `context.with()` is callback-scoped — so the Netra root span could never parent the inbound HTTP span, which is created before any handler callback runs. With Express instrumentation this produced split traces (the handler subtree and the Express span exported as separate traces). Use `rootInstruments` to control which instrumentations are allowed to produce root spans.

## [1.8.0] - 2026-08-03

### Added

- **Postscript Failed Status**: After-hook failures (`after`, `afterEach`, `afterAll`) on otherwise successful scenarios are now reported as `postscript_failed` instead of being logged and ignored. Existing failure statuses (`failed` / `prescript_failed`) are never overwritten. `after` and `afterEach` always both attempt to run; `afterAll` failure marks only successfully completed scenarios.

## [1.7.0] - 2026-07-27

### Added

- **Simulation Lifecycle Hooks**: Added prescript/postscript support for multi-turn simulations via `SimulationHooks` (`beforeAll`, `beforeEach`, `before`, `after`, `afterEach`, `afterAll`). Hooks can return setup context passed into `BaseTask.run`, and the run uses a two-phase initialize / first-turn flow so hooks execute before any LLM spend. Execution order is `beforeAll` → `beforeEach` → item-specific `before` → task → item-specific `after` → `afterEach` → `afterAll`. `beforeAll` failure aborts the run as `prescript_failed`; item `before` failure marks only that scenario; `after`, `afterEach`, and `afterAll` failures are logged and do not affect status.

## [1.6.0] - 2026-07-17

### Added

- **Reparent Children of Blocked Root Instruments**: When a root-instrument span is blocked, its children are no longer dropped along with the subtree. Instead they are reparented onto the blocked span's parent (a true root's children become the new roots), and the peel repeats for promoted spans that are themselves blocked. 
### Changed

- **Standardized Attribute Serialization**: Introduced a single `SerializationSpanProcessor` that serializes and truncates every span attribute at write time, replacing the removed `AttributeSizeLimitProcessor`. Truncation uses a `jsonrepair`-based serializer for JSON values (and a `...[TRUNCATED]` suffix for plain strings) to stay aligned with backend behavior, and runs before the scrubbing layer so the regex scrubber sees values in string form. The per-attribute cap is read lazily from `NETRA_SPAN_ATTRIBUTE_MAX_SIZE` (default 30000). Serialization helpers were consolidated under `src/utils/serialization/`.

### Fixed

- **`addConversation` Persistence**: Fixed appending conversation entries to the active span's `conversation` attribute so existing entries are parsed and preserved (rather than overwritten) when a new entry is added, with defensive fallback when the stored value cannot be parsed.

## [1.5.0] - 2026-07-10

### Added

- **Google GenAI Instrumentation**: Added instrumentation support for the Google GenAI (`@google/genai`) SDK, with a shared `base-instrumentor` abstraction and a separate `google-generative-ai` module.

### Fixed

- **OpenAI Agents Cache Tokens**: Captured cache token details (`cached_tokens`, `cache_write_tokens`, `reasoning_tokens`) for Claude models in OpenAI Agents instrumentation.
- **Raw Chat Completions Response**: Added a helper to handle usage from the Chat Completions API naming (`prompt_tokens`/`completion_tokens` and their token details) alongside the Responses API naming, so `OpenAIChatCompletionsModel` usage is captured correctly.
- **Span Input/Output on Active and Root Spans**: Updated utility functions so input and output attributes are set correctly on both the active span and the root span.

## [1.4.0] - 2026-07-02

### Added

- **Anthropic Tool Runner Support**: Added span capture for the Anthropic tool-runner flow, so tool-execution turns within an agentic Anthropic run are traced.
- **Attribute Size Limit Processor**: New `AttributeSizeLimitProcessor` enforces a hard per-attribute size cap (default 32KB, configurable via `NETRA_SPAN_ATTRIBUTE_MAX_SIZE`) by wrapping `setAttribute` on span start, preventing "entity too large" errors during export.
- **Resource Attributes Propagation**: `Config` now sets `OTEL_RESOURCE_ATTRIBUTES` so the `TracerProvider` resource carries `service.name` and `deployment.environment`, with precedence order: pre-existing env value > config `resourceAttributes` > Netra defaults.

### Changed

- **SDK Version Source**: `Config.LIBRARY_VERSION` now derives from `SDK_VERSION` in `src/version.ts` instead of a hardcoded string, keeping the reported library version in sync with the package version.

## [1.3.0] - 2026-07-01

### Added

- **NativeTracingMode**: Replaced the boolean `disableNativeTracing` option with a `NativeTracingMode` (`"both" | "netra" | "netra-strict"`) for granular control over where OpenAI Agents traces are sent. Configurable per-instrument or via the `NATIVE_TRACING_MODE` environment variable. `"netra"` routes traces to Netra only (falling back to additive mode with a warning if SDK APIs are unavailable), `"netra-strict"` (default) never falls back to native, and `"both"` sends to Netra and native.

### Fixed

- **Netra-only OpenAI Agents Tracing**: Added `canSet` gating and a restore fallback so the OpenAI Agents processor can be swapped safely, and included `OPENAI_AGENTS` in the root-span instrument allowlist (`DEFAULT_INSTRUMENTS_FOR_ROOT`) so agent runs are captured as root spans.

## [1.2.0] - 2026-06-23

### Added

- **Simulation File Handling**: The simulation workflow now supports file attachments on user messages. The SDK parses `attachments` metadata from the API (`FileData`), downloads the referenced content via pre-signed URLs, and delivers it to user tasks as base64-encoded `ProcessedFile` objects. `ProcessedFile` is now exported from the package root.

## [1.1.0] - 2026-06-16

### Added

- **Context Propagation Helpers**: Exported `netraExpressMiddleware` and `runWithExtractedContext` for distributed tracing. These utilities extract incoming W3C Trace Context from HTTP headers and run code within that context, covering cases where auto-instrumentation is unavailable (ESM load-order issues, missing peer dependencies, or non-Express frameworks). 

### Fixed

- **CommonJS (CJS) Support for LLM Provider Instrumentations**: Fixed instrumentation for Anthropic, Google GenAI, Groq, and Mistral AI so they patch correctly under CommonJS module resolution, resolving instrumentation failures in CJS applications.

## [1.5.0] - 2026-07-10

### Added

- **Google GenAI Instrumentation**: Added instrumentation support for the Google GenAI (`@google/genai`) SDK, with a shared `base-instrumentor` abstraction and a separate `google-generative-ai` module.

### Fixed

- **OpenAI Agents Cache Tokens**: Captured cache token details (`cached_tokens`, `cache_write_tokens`, `reasoning_tokens`) for Claude models in OpenAI Agents instrumentation.
- **Raw Chat Completions Response**: Added a helper to handle usage from the Chat Completions API naming (`prompt_tokens`/`completion_tokens` and their token details) alongside the Responses API naming, so `OpenAIChatCompletionsModel` usage is captured correctly.
- **Span Input/Output on Active and Root Spans**: Updated utility functions so input and output attributes are set correctly on both the active span and the root span.

## [1.4.0] - 2026-07-02

### Added

- **Anthropic Tool Runner Support**: Added span capture for the Anthropic tool-runner flow, so tool-execution turns within an agentic Anthropic run are traced.
- **Attribute Size Limit Processor**: New `AttributeSizeLimitProcessor` enforces a hard per-attribute size cap (default 32KB, configurable via `NETRA_SPAN_ATTRIBUTE_MAX_SIZE`) by wrapping `setAttribute` on span start, preventing "entity too large" errors during export.
- **Resource Attributes Propagation**: `Config` now sets `OTEL_RESOURCE_ATTRIBUTES` so the `TracerProvider` resource carries `service.name` and `deployment.environment`, with precedence order: pre-existing env value > config `resourceAttributes` > Netra defaults.

### Changed

- **SDK Version Source**: `Config.LIBRARY_VERSION` now derives from `SDK_VERSION` in `src/version.ts` instead of a hardcoded string, keeping the reported library version in sync with the package version.

## [1.3.0] - 2026-07-01

### Added

- **NativeTracingMode**: Replaced the boolean `disableNativeTracing` option with a `NativeTracingMode` (`"both" | "netra" | "netra-strict"`) for granular control over where OpenAI Agents traces are sent. Configurable per-instrument or via the `NATIVE_TRACING_MODE` environment variable. `"netra"` routes traces to Netra only (falling back to additive mode with a warning if SDK APIs are unavailable), `"netra-strict"` (default) never falls back to native, and `"both"` sends to Netra and native.

### Fixed

- **Netra-only OpenAI Agents Tracing**: Added `canSet` gating and a restore fallback so the OpenAI Agents processor can be swapped safely, and included `OPENAI_AGENTS` in the root-span instrument allowlist (`DEFAULT_INSTRUMENTS_FOR_ROOT`) so agent runs are captured as root spans.

## [1.2.0] - 2026-06-23

### Added

- **Simulation File Handling**: The simulation workflow now supports file attachments on user messages. The SDK parses `attachments` metadata from the API (`FileData`), downloads the referenced content via pre-signed URLs, and delivers it to user tasks as base64-encoded `ProcessedFile` objects. `ProcessedFile` is now exported from the package root.

## [1.1.0] - 2026-06-16

### Added

- **Context Propagation Helpers**: Exported `netraExpressMiddleware` and `runWithExtractedContext` for distributed tracing. These utilities extract incoming W3C Trace Context from HTTP headers and run code within that context, covering cases where auto-instrumentation is unavailable (ESM load-order issues, missing peer dependencies, or non-Express frameworks).

### Fixed

- **CommonJS (CJS) Support for LLM Provider Instrumentations**: Fixed instrumentation for Anthropic, Google GenAI, Groq, and Mistral AI so they patch correctly under CommonJS module resolution, resolving instrumentation failures in CJS applications.

## [1.1.0-beta.1] - 2026-06-09

### Fixed

- **Decorator Input Serialization**: Replaced raw `JSON.stringify` with a circular-reference-safe serializer in `@workflow`, `@agent`, `@task`, and `@span` decorators. Non-serializable arguments (e.g., Express `Response`, Sockets, Streams) now produce descriptive placeholders like `[ServerResponse]` instead of triggering `input_error` on the span.

## [1.1.0-beta.0] - 2026-06-08

### Added

- **OpenAI Agents Instrumentation**: Full instrumentation support for the `@openai/agents` SDK, including span creation, attribute extraction, and trace correlation for agent runs.
- **Prompt Management Utility**: Added API client and utilities for fetching and managing prompts programmatically.
- **Test Run Details Utility**: Added utility to fetch evaluation test run details via the API.
- **HTTP Instrumentation Support**: Registered Express and HTTP instrumentation within the SDK for automatic HTTP span capture.
- **Span Blocking Functionality**: Added local filtering span processor with pattern-matching support to selectively block spans from being exported.
- **SpanIOProcessor**: New processor to normalise input/output attributes across different instrumentation providers.

### Changed

- **Label Made Optional**: The `label` parameter is now optional when fetching prompts, aligning with Python SDK behavior.
- **SDK Parity with Python SDK**: Refactored core modules (decorators, session manager, instrumentation utilities) to reduce disparity with the Python SDK implementation.

### Fixed

- **Streaming Wrapper Serialization**: Made OTel properties on streaming wrappers non-enumerable to prevent circular JSON serialization errors in LangGraph, Mistral, and OpenAI instrumentations.

## [1.0.5] - 2026-02-18

- Added support for audio duration & character count metric in dashboard query

## [1.0.4] - 2026-02-04

### Added

- **Support for Multi Turn Evaluations**: The multi turn feature allows users to evaluate their agents by running conversation simulations against datasets.

### Technical Details

- Added `src/simulation` module with:
  - `Simulation` class for managing simulation runs
  - `SimulationHttpClient` for API communication
  - Data models for simulation items and results
- Implemented concurrency control using `p-limit` (default: 5 concurrent tasks)
- Added trace context propagation for simulation tasks

## [1.0.3] - 2026-01-31

### Fixed

- **LangGraph v0.2.x Hierarchy Fallback**: Added a best-effort parent inference stack when `parentRunId` is missing, so LangGraph node/LLM/tool spans can still nest under the workflow for older LangGraph versions.
- **LangGraph Node Naming**: Added runName/chainId fallback naming when `langgraph_node` metadata is absent to avoid unnamed spans.
- **LangChain Instrumentation Isolation**: When `NetraInstruments.LANGCHAIN` is disabled, Traceloop's LangChain callback handler injection is now blocked to prevent duplicate or flat traces.

## [1.0.2] - 2026-01-30

### Changed

- **Async Initialization by Default**: `Netra.init()` is now async by default and waits for all instrumentations to be ready before returning. This ensures instrumented modules are properly patched before the application starts using them. The previous `initAsync()` method is deprecated but still available for backwards compatibility.

### Fixed

- **LangGraph Module Resolution**: Fixed an issue where the SDK would patch its own copy of LangGraph instead of the application's module instance. The SDK now uses `require.cache` to find and patch the same module instance the application is using, ensuring instrumentation works correctly in NestJS and other frameworks.

- **LangGraph Prototype Chain**: Fixed instrumentation not working because `invoke()` and `stream()` methods are defined on the `Pregel` class (parent of `CompiledStateGraph`), not on `CompiledStateGraph` itself. The SDK now walks the prototype chain to find and patch the correct class.

- **Nested Instrumentation Prevention**: Fixed an issue where LangGraph's internal calls (e.g., `invoke()` calling `stream()` internally) would cause double instrumentation. Added a context flag (`LANGGRAPH_INSTRUMENTATION_ACTIVE`) to skip nested instrumentation calls.

- **Parent Context Propagation**: LangGraph spans now correctly inherit from the active parent span context, ensuring proper trace hierarchy when used with manual spans or HTTP request spans.

### Technical Details

- Modified `src/index.ts` to make `init()` async and await `instrumentationsReady`
- Added `findModuleInCache()` in `src/instrumentation/langgraph/index.ts` to resolve modules from `require.cache`
- Modified `_instrumentInvoke()` and `_instrumentStream()` to walk the prototype chain and find methods on `Pregel`
- Added `LANGGRAPH_INSTRUMENTATION_ACTIVE` context key in `src/instrumentation/langgraph/wrappers.ts` to prevent nested instrumentation

## [1.0.1] - 2026-01-29

### Fixed

- **Context Propagation in LangGraph**: Fixed an issue where LangGraph `invoke()` method was creating spans without parent context, causing each span to appear as a separate trace instead of being nested under the same trace. The `invoke()` method now properly passes `context.active()` when creating spans, matching the behavior of the `stream()` method.

- **Selective Instrumentation**: Fixed an issue where specifying a specific set of instruments (e.g., only `NetraInstruments.ANTHROPIC`) would still instrument all libraries. This was caused by Traceloop treating an empty `instrumentModules` object as "enable all defaults". The SDK now explicitly disables all Traceloop modules when specific instruments are provided, ensuring only the requested instruments are enabled.

### Technical Details

- Modified `src/instrumentation/langgraph/wrappers.ts` to pass `context.active()` as the third parameter to `tracer.startSpan()` in the `invoke()` method
- Modified `src/instrumentation/index.ts` to explicitly set all Traceloop instrument modules to `false` when specific instruments are configured, preventing unwanted default instrumentations

## [1.0.0] - 2026-01-29

### Added

- Initial release of Netra SDK
- Comprehensive TypeScript/JavaScript SDK for AI application observability
- Support for multiple LLM providers:
  - OpenAI
  - Anthropic
  - Google Generative AI
  - Mistral AI
  - Groq
  - Vertex AI
- Support for AI frameworks:
  - LangChain
  - LangGraph
  - LlamaIndex
- Vector database instrumentation:
  - Pinecone
  - Qdrant
  - ChromaDB
- Database instrumentation:
  - Prisma
  - TypeORM
- Web framework instrumentation:
  - Express
  - NestJS
- Built on OpenTelemetry and Traceloop
- Custom span processors for session management, scrubbing, and instrumentation metadata
- Trial-aware OTLP exporter with graceful degradation
- Filtering and local context-based span blocking
- API clients for Usage, Evaluation, and Dashboard
- Support for both ESM and CommonJS
