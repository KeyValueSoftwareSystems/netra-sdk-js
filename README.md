# Netra SDK for TypeScript/JavaScript

🚀 **Netra SDK** is a comprehensive TypeScript/JavaScript library for AI application observability that provides OpenTelemetry-based monitoring and tracing for LLM applications. It enables easy instrumentation, session tracking, and analysis for AI systems.

## ✨ Key Features

- 🔍 **Comprehensive AI Observability**: Monitor LLM calls, vector database operations, and HTTP requests
- 📊 **OpenTelemetry Integration**: Industry-standard tracing and metrics built on top of Traceloop
- 🎯 **Decorator Support**: Easy instrumentation with `@workflow`, `@agent`, and `@task` decorators
- 🔧 **Multi-Provider Support**: Works with OpenAI, Google GenAI, Mistral, Anthropic, and more
- 📈 **Session Management**: Track user sessions and custom attributes
- 🌐 **Automatic Instrumentation**: Zero-code instrumentation for popular frameworks and libraries
- ⚡ **Opt-in Read Caching**: In-memory TTL caching for read-heavy SDK calls (`getPrompt`, `getModelPricing`)

## 📦 Installation

Install the SDK via npm:

```bash
npm install netra-sdk
```

## 🚀 Quick Start

### Basic Setup

Initialize the Netra SDK at the start of your application (entry point). The `init()` method is async and waits for all instrumentations to be ready before returning:

```typescript
import { Netra, NetraInstruments } from "netra-sdk";

await Netra.init({
  appName: "my-ai-app",
  headers: `x-api-key=${process.env.NETRA_API_KEY}`, // Optional: Send traces to Netra Platform
  environment: "production",
  // Optional: Select specific instruments
  instruments: new Set([NetraInstruments.OPENAI, NetraInstruments.LANGCHAIN]),
});
```

> **Note**: Always `await` the `init()` call to ensure all instrumentations (like OpenAI, Anthropic, LangGraph) are fully patched before your application starts using them. This is especially important in frameworks like NestJS where modules are loaded after initialization.

## 🎯 Decorators

Use decorators to automatically trace your functions and classes. 

> **Note**: You must enable `experimentalDecorators` in your `tsconfig.json`.

```json
{
  "compilerOptions": {
    "experimentalDecorators": true
  }
}
```

### Usage

```typescript
import { agent, task, workflow } from "netra-sdk";

@agent
class SupportAgent {
  @task
  async handleRequest(query: string) {
    return await this.process(query);
  }

  @task({ name: "process-query" })
  async process(query: string) {
    // ... logic ...
  }
}

@workflow
async function mainWorkflow(input: any) {
    await new SupportAgent().handleRequest(input);
}
```

## 🔍 Supported Instrumentations

The SDK supports automatic instrumentation for various providers and frameworks:

### 🤖 LLM Providers
- OpenAI
- Anthropic Claude
- Google Gemini (Vertex AI & AI Studio)
- Mistral AI
- Groq
- Together AI
- Ollama
- Bedrock (AWS)

### 🛠 AI Frameworks
- LangChain
- LangGraph
- LlamaIndex

### 💾 Vector Databases
- Pinecone
- Qdrant
- ChromaDB
- Weaviate

### 🌐 HTTP & Web
- Express
- Fastify
- NestJS
- HTTP / HTTPS / Fetch

### 🗄️ Databases
- Prisma
- TypeORM
- MongoDB
- Postgres / MySQL / Redis

To configure specific instruments, use `NetraInstruments`:

```typescript
import { Netra, NetraInstruments } from "netra-sdk";

await Netra.init({
    instruments: new Set([
        NetraInstruments.OPENAI,
        NetraInstruments.EXPRESS
    ])
});
```

## 📊 Context and Event Logging

Track user sessions and add custom context to your traces.

```typescript
import { Netra } from "netra-sdk";

// Set Identity Context
Netra.setUserId("user-123");
Netra.setSessionId("session-abc");
Netra.setTenantId("tenant-xyz");

// Add Custom Attributes
Netra.setCustomAttributes("customer_tier", "premium");
Netra.setCustomAttributes("region", "us-east");

// Record Custom Events
Netra.setCustomEvent("user_feedback", {
    rating: 5,
    comment: "Great response!",
    category: "positive"
});
```

## 🔄 Custom Span Tracking

You can manually track spans for fine-grained observability using `startSpan`.

```typescript
import { Netra, SpanType } from "netra-sdk";

async function generateContent(prompt: string) {
  // Start a span
  const span = Netra.startSpan("generate-content", { 
      asType: SpanType.GENERATION,
      attributes: { model: "gpt-4" }
  });

  span.setPrompt(prompt);
  span.setLlmSystem("openai");

  try {
    // ... perform operation ...
    const result = "AI Generated Content";
    
    span.setSuccess();
    return result;
  } catch (error) {
    span.setError(error.message);
    throw error;
  } finally {
    // Always end the span!
    span.end();
  }
}
```

## 📝 Prompts API

Fetch prompt versions from Prompt Studio via `Netra.prompts.getPrompt()`. Caching is **opt-in per call** — omit `useCache` (or set it to `false`) to always hit the API.

Default TTL is **60 seconds** (`PROMPT_CACHE_TTL_SECONDS`). Override TTL for a single call with `cacheTtl`.

```typescript
import { Netra } from "netra-sdk";

await Netra.init({
  appName: "my-ai-app",
});

// Always fetches from the API (default)
const prompt = await Netra.prompts.getPrompt({ name: "my-prompt" });

// Cached for 60s (default TTL)
const cached = await Netra.prompts.getPrompt({
  name: "my-prompt",
  useCache: true,
});

// Cached for 30s for this call only
const shortLived = await Netra.prompts.getPrompt({
  name: "my-prompt",
  label: "production", // default label when omitted
  useCache: true,
  cacheTtl: 30,
});
```

> **Note**: Cached prompts may be stale for up to the TTL after dashboard edits. Use `useCache: false` when you need the latest version immediately. `Netra.shutdown()` clears in-memory caches.

## 💰 Models API

Fetch model pricing via `Netra.models.getModelPricing()`. Caching is **opt-in per call** — omit `useCache` (or set it to `false`) to always hit the API.

Default TTL is **300 seconds** (`MODEL_PRICING_CACHE_TTL_SECONDS`). Override TTL for a single call with `cacheTtl`.

```typescript
import { Netra } from "netra-sdk";

await Netra.init({
  appName: "my-ai-app",
});

// Always fetches from the API (default)
const pricing = await Netra.models.getModelPricing();

// Optional name filter
const gptPricing = await Netra.models.getModelPricing({ name: "gpt-4o" });

// Cached for 300s (default TTL)
const cached = await Netra.models.getModelPricing({
  useCache: true,
});

// Cached for 60s for this call only
const shortLived = await Netra.models.getModelPricing({
  name: "gpt-4o",
  useCache: true,
  cacheTtl: 60,
});
```

> **Note**: Cached pricing may be stale for up to the TTL after dashboard edits. Use `useCache: false` when you need the latest values immediately. `Netra.shutdown()` clears in-memory caches.

## 🔧 Environment Variables

You can configure the SDK using environment variables:

| Variable | Description |
|----------|-------------|
| `NETRA_API_KEY` | API Key for Netra Platform |
| `NETRA_APP_NAME` | Name of your application |
| `NETRA_ENV` | Environment (e.g., prod, dev) |
| `NETRA_TRACE_CONTENT` | Capture prompt/completion content (default: true) |

## 🤝 License

Apache-2.0
