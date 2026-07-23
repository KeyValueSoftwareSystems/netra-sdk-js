# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [1.7.0] - 2026-07-23

### Changed

- **Evaluation/simulation trace origin label** — Root spans created for evaluation and simulation runs now carry a `netra.trace.origin` attribute (`Config.TRACE_ORIGIN_KEY`) set to `"evaluation"` (`Config.TRACE_ORIGIN_EVALUATION`), so the backend/frontend can distinguish these traces from normal workflow invocations.


## [1.6.0] - 2026-07-14

### Added

- **SerializationSpanProcessor** — New span processor that serializes and truncates span attributes at write time via `setAttribute` wrapping. Uses `jsonrepair`-based truncation for JSON values and `...[TRUNCATED]` suffix for plain strings.

### Changed

- **Span processor registration order** — `ScrubbingSpanProcessor` is now registered before `SerializationSpanProcessor` so that serialization executes first in the `setAttribute` wrapper chain, converting values to strings before the scrubber runs its regex-based redaction.
- **Lazy env var loading** — `Config.SPAN_ATTRIBUTE_MAX_SIZE` is now a lazy getter that reads `process.env` on first access rather than at import time, so environment variables set before `Netra.init()` are always respected. Removed the `dotenv` dependency — env loading is the application's responsibility.

### Fixed

- **Conversation accumulation** — `addConversation` now correctly reads existing entries from `span.attributes` instead of the internal `_attributes` property, so all conversation entries are persisted rather than only the last one.
- **Error data truncation** — `span.setStatus({ message })` in the OpenAI Agents processor now enforces a 4 KB limit on error data using `safeStringify`, preventing unbounded error messages.

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
