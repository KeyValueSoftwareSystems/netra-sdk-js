import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./instrumentation", () => ({
  initInstrumentations: vi.fn(() => ({})),
  instrumentationsReady: Promise.resolve(),
  uninstrumentAll: vi.fn(() => Promise.resolve()),
}));

import { Netra } from "./index";
import { FLUSH_TIMEOUT_MS } from "./shutdown-registry";

const EVENTS = ["SIGINT", "SIGTERM", "uncaughtException", "beforeExit"] as const;
const counts = () => EVENTS.map((e) => process.listenerCount(e));

describe("Netra process shutdown hooks", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    if (Netra.isInitialized()) {
      await Netra.shutdown();
    }
  });

  it("registers hooks on init and removes them on shutdown", async () => {
    const before = counts();
    await Netra.init({});
    expect(counts()).toEqual(before.map((c) => c + 1));

    await Netra.shutdown();
    expect(counts()).toEqual(before);
  });

  it("does not register hooks when registerShutdownHooks is false", async () => {
    const before = counts();
    await Netra.init({ registerShutdownHooks: false });
    expect(counts()).toEqual(before);
  });

  it("never arms unhandledRejection for an ordinary init", async () => {
    // Merely having an unhandledRejection listener suppresses Node's default
    // crash behaviour, so the SDK must not install one just because something
    // registered an exit task. Only the simulation runner opts in, and only
    // for the duration of a run.
    const before = process.listenerCount("unhandledRejection");
    await Netra.init({});
    expect(process.listenerCount("unhandledRejection")).toBe(before);

    await Netra.shutdown();
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });

  it("flushes on a signal without exiting while the app has its own handler", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const appHandler = vi.fn();
    process.on("SIGTERM", appHandler);
    try {
      await Netra.init({});
      process.emit("SIGTERM", "SIGTERM");
      await vi.waitFor(() => expect(Netra.isInitialized()).toBe(false));
      await new Promise((r) => setImmediate(r));

      expect(appHandler).toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      process.removeListener("SIGTERM", appHandler);
    }
  });

  it("re-raises the signal after flushing when no other handler exists", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const others = process.listeners("SIGINT");
    others.forEach((l) => process.removeListener("SIGINT", l));
    try {
      await Netra.init({});
      process.emit("SIGINT", "SIGINT");
      await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT"));
      expect(exit).not.toHaveBeenCalled();
    } finally {
      others.forEach((l) => process.on("SIGINT", l));
    }
  });

  it("shares one in-flight shutdown between concurrent callers", async () => {
    await Netra.init({ registerShutdownHooks: false });

    let finishFlush!: () => void;
    const forceFlush = vi.fn(
      () => new Promise<void>((resolve) => (finishFlush = resolve)),
    );
    const shutdown = vi.fn(() => Promise.resolve());
    vi.spyOn(trace, "getTracerProvider").mockReturnValue({
      getTracer: vi.fn(),
      forceFlush,
      shutdown,
    } as never);

    let firstDone = false;
    let secondDone = false;
    const first = Netra.shutdown().then(() => (firstDone = true));
    const second = Netra.shutdown().then(() => (secondDone = true));

    await vi.waitFor(() => expect(forceFlush).toHaveBeenCalled());
    await new Promise((r) => setImmediate(r));
    // Neither caller resolves before the flush has completed.
    expect(firstDone).toBe(false);
    expect(secondDone).toBe(false);

    finishFlush();
    await Promise.all([first, second]);
    expect(forceFlush).toHaveBeenCalledTimes(1);
    // Flush only: Traceloop cannot re-initialize a shut-down provider.
    expect(shutdown).not.toHaveBeenCalled();
    expect(Netra.isInitialized()).toBe(false);

    // A later call after completion is a no-op.
    await Netra.shutdown();
    expect(forceFlush).toHaveBeenCalledTimes(1);
  });

  it("flushes the real provider behind OTel's global proxy", async () => {
    await Netra.init({ registerShutdownHooks: false });

    const forceFlush = vi.fn(() => Promise.resolve());
    // ProxyTracerProvider exposes neither forceFlush nor shutdown itself.
    vi.spyOn(trace, "getTracerProvider").mockReturnValue({
      getTracer: vi.fn(),
      getDelegate: () => ({ getTracer: vi.fn(), forceFlush }),
    } as never);

    await Netra.shutdown();
    expect(forceFlush).toHaveBeenCalledTimes(1);
  });

  it("does not leave the flush timeout pending once the flush has finished", async () => {
    // A live 5s timer would hold the event loop open, so an app that exits by
    // draining (or via beforeExit) would linger for the whole flush budget.
    await Netra.init({ registerShutdownHooks: false });
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const set = vi.spyOn(globalThis, "setTimeout");

    await Netra.shutdown();

    const flushTimer = set.mock.results.find(
      (_, i) => set.mock.calls[i][1] === FLUSH_TIMEOUT_MS,
    )?.value;
    expect(flushTimer).toBeDefined();
    expect(clear).toHaveBeenCalledWith(flushTimer);
  });

  it("init() waits for an in-flight shutdown instead of being ignored", async () => {
    await Netra.init({ registerShutdownHooks: false });
    const pending = Netra.shutdown();
    await Netra.init({ registerShutdownHooks: false });
    await pending;
    expect(Netra.isInitialized()).toBe(true);
  });
});
