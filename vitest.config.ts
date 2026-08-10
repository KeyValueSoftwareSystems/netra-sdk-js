import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "src/api/redteam/**/*.ts",
        "src/api/models/**/*.ts",
        "src/api/prompts/**/*.ts",
        "src/cache.ts",
      ],
      exclude: [
        "src/api/redteam/**/__tests__/**",
        "src/api/redteam/index.ts",
        "src/api/models/*.test.ts",
        "src/api/models/index.ts",
        "src/api/prompts/*.test.ts",
        "src/api/prompts/index.ts",
      ],
      thresholds: {
        lines: 80,
      },
    },
  },
});
