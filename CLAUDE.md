# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build                          # tsup → dist/ (ESM + CJS + .d.ts), entry src/index.ts
npm run start:dev                      # tsup --watch
npm test                               # vitest run (all *.test.ts under src/)
npx vitest run src/cache.test.ts       # single file
npx vitest run -t "registers hooks"    # single test by name
npx tsc --noEmit                       # typecheck (no npm script for it; there is no linter configured)
```

There is no vitest config file; defaults apply. `src/shutdown-registry.integration.test.ts` bundles fixtures from `src/__fixtures__/` with `node_modules/.bin/esbuild` and spawns real child processes that receive real signals — keep fixtures runnable as plain Node after bundling.

## Releasing

- The version lives in **two** places that must match: `package.json` and `src/version.ts` (`SDK_VERSION`). `src/version.test.ts` fails if they drift.
- `CHANGELOG.md` follows Keep a Changelog; add an entry under the new version.
- `.github/workflows/release-notes.yml` (manual dispatch) drafts GitHub release notes via `.github/scripts/generate-release-notes.sh`.

## Architecture

Netra is an observability SDK for LLM apps built on OpenTelemetry, layered on top of **Traceloop** (`@traceloop/node-server-sdk`). Public surface is the static `Netra` class in `src/index.ts` plus decorators (`@workflow`, `@agent`, `@task`, `@span` in `src/decorators.ts`) and many re-exported types.

### Init flow (`Netra.init` → `initInstrumentations` in `src/instrumentation/index.ts`)

1. `Config` (`src/config.ts`) merges `NetraConfig` with `NETRA_*` env vars, then `setTraceloopEnv()` mirrors them into `TRACELOOP_*` env vars.
2. Resolve the instrument set: explicit `instruments`, else `DEFAULT_INSTRUMENTS`; `NetraInstruments.ALL` enables everything; `blockInstruments` subtracts. Instruments split into two families:
   - **Traceloop-provided** (LangChain, Vertex AI, LlamaIndex, Pinecone, Qdrant, Chroma, Together) — passed via Traceloop's `instrumentModules`; all start disabled and are enabled only if requested and the package resolves.
   - **Netra custom instrumentors** (OpenAI, Anthropic, Groq, Mistral, Google GenAI, Google Generative AI, LangGraph, OpenAI Agents, TypeORM) under `src/instrumentation/<provider>/` — monkey-patch SDK prototypes with `shimmer`.
   - Plus stock OTel instrumentations (HTTP, undici, Express, Prisma) in `initOpenTelemetryInstrumentations`.
3. Build the exporter: `ConsoleSpanExporter` when no endpoint, else `TrialAwareOTLPExporter` (Protobuf OTLP over its own HTTP transport so it can read error bodies); always wrapped in `FilteringSpanExporter`, which shares `blockedParentMap` with `LocalFilteringSpanProcessor` to reparent children of blocked spans.
4. Traceloop `initialize()` creates the provider. `addCustomSpanProcessors` then digs the real provider out of OTel's `ProxyTracerProvider` (`_delegate` / `getDelegate()` / pushing into `MultiSpanProcessor._spanProcessors`) and registers Netra's processors.
5. Custom instrumentors patch **asynchronously**; `instrumentationsReady` is the promise `init()` awaits. They resolve the target package via ESM `import()` first and CJS `require` second so they patch the same module instance the app uses (dual-package hazard).

### Span processor order matters

Several processors wrap `span.setAttribute` in `onStart`; the last registered wrapper is the outermost. The chain for an external `setAttribute` is **SpanIOProcessor → SerializationSpanProcessor → ScrubbingSpanProcessor → OTel**. Serialization must run before scrubbing (scrubber is regex over strings). Processors that only *call* `setAttribute` (Instrumentation, Session, LlmTraceIdentifier, RootSpan) must be registered after all wrappers. See the comment block in `addCustomSpanProcessors` before reordering or adding a processor.

`RootInstrumentFilterProcessor` (driven by `rootInstruments`, default `DEFAULT_INSTRUMENTS_FOR_ROOT`) drops root spans from non-allowed instrumentations (e.g. an Express server span) and recursively promotes their children; spans with a remote parent are kept.

### Instrumentors

`BaseInstrumentor` (`src/instrumentation/base-instrumentor.ts`) owns ESM/CJS resolution with dedup, the single in-flight-promise concurrency guard, and the `isInstrumented` lifecycle; subclasses implement `extractClasses` / `applyPatches` / `removePatches`. Currently only the Google GenAI and Google Generative AI instrumentors extend it — the others hand-roll the same lifecycle. Each provider folder follows `index.ts` (instrumentor singleton), `wrappers.ts`, `utils.ts`, `version.ts`. A new instrumentor must also be wired into `initCustomInstrumentationsAsync` and `uninstrumentAll`, and added to `NetraInstruments`.

### Context and sessions

`setUserId` / `setSessionId` / `setTenantId` write to OTel **baggage** (`setSessionBaggage` in `src/processors`) and the active span; `SessionSpanProcessor` copies baggage onto every new span. The global propagator is W3C TraceContext + Baggage. `SessionManager` (`src/session-manager.ts`) handles input/output, custom events and conversation entries on the active span. `src/utils/context-propagation.ts` provides `netraExpressMiddleware` / `runWithExtractedContext` for distributed traces. `src/utils/response-handler.ts` (`wrapResponse`) keeps a span open until a returned promise settles or an async iterable (streaming response) is fully consumed — reuse it rather than ending spans synchronously.

### Shutdown

`src/shutdown-registry.ts` is the **single owner** of exit-deciding `process` listeners (SIGINT/SIGTERM/uncaughtException/opt-in unhandledRejection). Components register exit tasks there rather than adding their own listeners — two independent listeners previously raced to re-raise signals. The SDK never chooses when or with what code the process exits; it re-raises only if the app has no handler of its own. `beforeExit` is deliberately handled in `Netra` itself, not the registry. `Netra.shutdown()` is idempotent and concurrent-safe, flushes with a `FLUSH_TIMEOUT_MS` budget, and **never shuts the provider down** (Traceloop's `initialize()` is one-shot per process, so a re-`init()` reuses it).

### Platform API clients (`src/api/`, `src/simulation/`)

Each area (prompts, models, usage, dashboard, evaluation) is split into `client.ts` (extends `NetraHttpClient`, axios, per-area timeout env var), `api.ts` (public class exposed as `Netra.<area>`), and `models.ts` (types/constants). `Prompts.getPrompt` and `Models.getModelPricing` support opt-in `TTLCache` caching (`src/cache.ts`, deep-copies on get/set); `Netra.shutdown()` clears these caches. `Simulation` registers its own short-lived exit tasks so an interrupted run is marked `failed`.

### Packaging

- ESM-first (`"type": "module"`), dual ESM/CJS output; code uses `createRequire(import.meta.url)` where CJS resolution is needed.
- `tsup.config.ts` forces `@langchain/*`, `@traceloop/instrumentation-*` and `langsmith` external so they are never vendored into `dist/`.
- Provider SDKs are optional peer dependencies — never import them statically; resolve at runtime and no-op when absent.
- `experimentalDecorators` / `emitDecoratorMetadata` are enabled (legacy TS decorators).
- Behaviour is kept at parity with the Netra Python SDK; comments referencing "Python parity" mark intentional mirroring.
