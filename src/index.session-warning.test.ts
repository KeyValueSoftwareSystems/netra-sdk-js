/**
 * When no AsyncLocalStorage-based context manager is registered, the identity
 * setters fall back to the active span and warn. On a server that would print
 * once per request, so the warning must appear only once per process.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./processors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./processors")>();
  return { ...actual, setSessionValue: vi.fn(() => false) };
});

import { Netra } from "./index";

describe("identity setters without a context manager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns only once across repeated setter calls", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let i = 0; i < 5; i++) {
      Netra.setSessionId(`session-${i}`);
      Netra.setUserId(`user-${i}`);
      Netra.setTenantId(`tenant-${i}`);
    }

    const contextWarnings = warn.mock.calls.filter((args) =>
      args.some((a) => typeof a === "string" && a.includes("context manager")),
    );
    expect(contextWarnings).toHaveLength(1);
  });
});
