/**
 * Debug script for Google GenAI instrumentation
 *
 * HOW TO USE:
 * 1. Set breakpoints in the instrumentation files (see suggested locations below)
 * 2. Press F5 or go to Run > Start Debugging
 * 3. Select "Debug Google GenAI Instrumentation"
 * 4. Step through the code!
 *
 * SUGGESTED BREAKPOINTS:
 * - src/instrumentation/google-genai/index.ts:
 *   - Line (resolveGoogleGenerativeAIAsync)
 *   - Line (prototype patching)
 *
 * - src/instrumentation/google-genai/wrappers.ts:
 *   - Line (googleGenAIWrapper function)
 *   - Line (googleGenAIStreamWrapper function)
 *   - Line (shouldSuppressInstrumentation check)
 *   - Line (tracer.startActiveSpan)
 *   - Line (setRequestAttributes)
 *   - Line (setResponseAttributes)
 */

import { DiagConsoleLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { googleGenerativeAIInstrumentor } from "../src/instrumentation/google-genai";

// Enable OpenTelemetry diagnostics (optional)
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

async function main() {
  console.log("=== Google GenAI Instrumentation Debug Session ===\n");

  // STEP 1: Setup tracing provider
  console.log("1️⃣ Setting up TracerProvider...");
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
  });
  provider.register();
  console.log("   ✅ TracerProvider registered\n");

  // STEP 2: Instrument Google GenAI (SET BREAKPOINT HERE)
  console.log("2️⃣ Instrumenting Google GenAI...");
  await googleGenerativeAIInstrumentor.instrumentAsync({
    tracerProvider: provider,
  });
  console.log(
    "   ✅ Google GenAI instrumented:",
    googleGenerativeAIInstrumentor.isInstrumented(),
  );
  console.log("");

  // STEP 3: Import and create client AFTER instrumentation
  console.log("3️⃣ Creating Google GenAI client...");
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(
    process.env.GOOGLE_GENAI_API_KEY ||
      "AIzaSyALq4VgvfhF6dLVC-RDH5jKH3Pl2AjwY98",
  );
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
    systemInstruction:
      "You are a helpful assistant. Always be concise and polite.",
  });
  console.log("   ✅ Client created\n");

  // STEP 4: Make a NON-STREAM API call (SET BREAKPOINT IN wrappers.ts)
  console.log("4️⃣ Making generateContent request...");
  console.log("   📤 Sending request to Google GenAI...\n");

  try {
    const result = await model.generateContent([
      { text: "System Instruction: You are a helpful assistant" },
      { text: "Say 'Hello Debug!' in exactly 2 words" },
    ]);
    const response = result.response;
    const text = response.text();

    console.log("\n   📥 Response received:");
    console.log("   Content:", text);
  } catch (error) {
    console.error("   ❌ API Error (generateContent):", error);
  }

  // STEP 5: Make a STREAMING API call (SET BREAKPOINT IN googleGenAIStreamWrapper)
  console.log("\n5️⃣ Making generateContentStream request...");
  console.log("   📤 Streaming request to Google GenAI...\n");

  try {
    const streamResult = await model.generateContentStream(
      "Write exactly 1 short line about observability.",
    );

    let fullText = "";

    // This is the key part: consume the async iterable
    for await (const chunk of streamResult.stream) {
      const t = typeof chunk?.text === "function" ? chunk.text() : chunk?.text;

      if (typeof t === "string") {
        process.stdout.write(t);
        fullText += t;
      }
    }

    console.log("\n\n   ✅ Stream complete");
    console.log("   Full streamed content:", fullText);
  } catch (error) {
    console.error("   ❌ API Error (generateContentStream):", error);
  }

  // STEP 6: Uninstrument
  console.log("\n6️⃣ Uninstrumenting...");
  googleGenerativeAIInstrumentor.uninstrument();
  console.log(
    "   ✅ Google GenAI uninstrumented:",
    !googleGenerativeAIInstrumentor.isInstrumented(),
  );

  console.log("\n=== Debug Session Complete ===");
}

main().catch(console.error);
