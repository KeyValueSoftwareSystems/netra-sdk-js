import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  outDir: "dist",
  // tsup externalizes declared dependencies/peers automatically; list the
  // LangChain packages explicitly as well so they are never inlined into dist/
  // (vendored code is invisible to consumers' npm audit and duplicates classes).
  external: [
    /^@langchain\//,
    /^@traceloop\/instrumentation-/,
    /^langsmith(\/|$)/,
  ],
});
