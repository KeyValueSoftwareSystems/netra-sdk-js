import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./instrumentation", () => ({
  initInstrumentations: vi.fn(() => ({})),
  instrumentationsReady: Promise.resolve(),
  uninstrumentAll: vi.fn(() => Promise.resolve()),
}));

import { Netra } from "./index";

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
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(Netra.isInitialized()).toBe(false);

    // A later call after completion is a no-op.
    await Netra.shutdown();
    expect(forceFlush).toHaveBeenCalledTimes(1);
  });

  it("init() waits for an in-flight shutdown instead of being ignored", async () => {
    await Netra.init({ registerShutdownHooks: false });
    const pending = Netra.shutdown();
    await Netra.init({ registerShutdownHooks: false });
    await pending;
    expect(Netra.isInitialized()).toBe(true);
  });
});
