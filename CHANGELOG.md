# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
