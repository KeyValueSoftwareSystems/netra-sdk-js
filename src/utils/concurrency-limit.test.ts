import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createLimit } from "./concurrency-limit";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("createLimit", () => {
  it("never runs more than `concurrency` tasks at once and keeps results", async () => {
    const limit = createLimit(2);
    let running = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limit(async () => {
          running++;
          peak = Math.max(peak, running);
          await tick();
          running--;
          return i;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("propagates sync throws and async rejections and keeps going", async () => {
    const limit = createLimit(1);
    await expect(limit(() => { throw new Error("sync"); })).rejects.toThrow("sync");
    await expect(limit(async () => { throw new Error("async"); })).rejects.toThrow("async");
    await expect(limit(() => 42)).resolves.toBe(42);
  });

  it("clearQueue drops tasks that have not started", async () => {
    const limit = createLimit(1);
    const started: number[] = [];
    const first = limit(async () => { started.push(1); await tick(); });
    void limit(async () => { started.push(2); });
    expect(limit.pendingCount).toBe(1);
    limit.clearQueue();
    await first;
    await tick();
    expect(started).toEqual([1]);
    expect(limit.activeCount).toBe(0);
  });

  it("rejects invalid concurrency", () => {
    expect(() => createLimit(0)).toThrow(TypeError);
    expect(() => createLimit(1.5)).toThrow(TypeError);
  });
});

/**
 * JS-PERF-004: the CommonJS build `require()`s every runtime dependency at load
 * time, so each one must load with require() on Node versions without
 * require(esm) support (Node 18, 20 < 20.19, 22 < 22.12). Newer Node is put in
 * that mode with --no-experimental-require-module.
 */
describe("runtime dependencies", () => {
  const root = join(__dirname, "..", "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const deps = Object.keys(pkg.dependencies ?? {});

  it("can all be loaded with require() without require(esm)", () => {
    const flags = (process as any).features?.require_module !== undefined
      ? ["--no-experimental-require-module"]
      : [];
    const script = `
      const failed = [];
      for (const d of ${JSON.stringify(deps)}) {
        try { require(d); } catch (e) { if (e && e.code === "ERR_REQUIRE_ESM") failed.push(d + ": " + e.code); }
      }
      process.stdout.write(JSON.stringify(failed));
    `;
    const out = execFileSync(process.execPath, [...flags, "-e", script], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(JSON.parse(out)).toEqual([]);
  }, 60_000);
});
