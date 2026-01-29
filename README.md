# Netra SDK for TypeScript/JavaScript

🚀 **Netra SDK** is a comprehensive TypeScript/JavaScript library for AI application observability that provides OpenTelemetry-based monitoring and tracing for LLM applications. It enables easy instrumentation, session tracking, and analysis for AI systems.

## ✨ Key Features

- 🔍 **Comprehensive AI Observability**: Monitor LLM calls, vector database operations, and HTTP requests
- 📊 **OpenTelemetry Integration**: Industry-standard tracing and metrics built on top of Traceloop
- 🎯 **Decorator Support**: Easy instrumentation with `@workflow`, `@agent`, and `@task` decorators
- 🔧 **Multi-Provider Support**: Works with OpenAI, Google GenAI, Mistral, Anthropic, and more
- 📈 **Session Management**: Track user sessions and custom attributes
- 🌐 **Automatic Instrumentation**: Zero-code instrumentation for popular frameworks and libraries

## 📦 Installation

Install the SDK via npm:

```bash
npm install netra-sdk
```

## 🚀 Quick Start

### Basic Setup

Initialize the Netra SDK at the start of your application (entry point):

```typescript
import { Netra, NetraInstruments } from "netra-sdk";

Netra.init({
  appName: "my-ai-app",
  headers: `x-api-key=${process.env.NETRA_API_KEY}`, // Optional: Send traces to Netra Platform
  environment: "production",
  // Optional: Select specific instruments
  instruments: new Set([NetraInstruments.OPENAI, NetraInstruments.LANGCHAIN]),
});
```

### Async Initialization

If you need to ensure all instrumentations (like OpenAI, Anthropic) are fully patched before use, use `initAsync`:

```typescript
await Netra.initAsync({
  appName: "my-ai-app",
  headers: `x-api-key=${process.env.NETRA_API_KEY}`,
});
```

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

Netra.init({
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
