import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { executeHandler, RedteamAgentHandler } from "../task";

describe("executeHandler", () => {
  it("resolves a plain async function's string return to {output}", async () => {
    const handler: RedteamAgentHandler = async (prompt) => `echo:${prompt}`;
    const result = await executeHandler(handler, "hello", "sess-1", 0);
    expect(result).toEqual({ output: "echo:hello" });
  });

  it("tolerates a sync function's string return (await on non-Promise is a no-op)", async () => {
    const handler: RedteamAgentHandler = (prompt) => `sync:${prompt}`;
    const result = await executeHandler(handler, "hi", "sess-2", 1);
    expect(result).toEqual({ output: "sync:hi" });
  });

  it("extracts {message, sessionId} return shape", async () => {
    const handler: RedteamAgentHandler = async () => ({
      message: "the reply",
      sessionId: "override-session",
    });
    const result = await executeHandler(handler, "prompt", "sess-3", 2);
    expect(result).toEqual({ output: "the reply", sessionId: "override-session" });
  });

  it("extracts {message} without sessionId override", async () => {
    const handler: RedteamAgentHandler = async () => ({ message: "no override" });
    const result = await executeHandler(handler, "prompt", "sess-4", 0);
    expect(result).toEqual({ output: "no override", sessionId: undefined });
  });

  it("throws on a bad-shape return (number)", async () => {
    const handler = (async () => 42) as unknown as RedteamAgentHandler;
    await expect(executeHandler(handler, "p", "s", 0)).rejects.toThrow(
      /must return string/,
    );
  });

  it("throws on a bad-shape return (null)", async () => {
    const handler = (async () => null) as unknown as RedteamAgentHandler;
    await expect(executeHandler(handler, "p", "s", 0)).rejects.toThrow(
      /must return string/,
    );
  });

  it("throws on a bad-shape return (object missing message)", async () => {
    const handler = (async () => ({ foo: "bar" })) as unknown as RedteamAgentHandler;
    await expect(executeHandler(handler, "p", "s", 0)).rejects.toThrow(
      /must return string/,
    );
  });

  it("passes turnIndex as the third positional argument to the handler", async () => {
    const handler = vi.fn(async (_prompt: string, _sessionId: string, _turnIndex: number) => "ok");
    await executeHandler(handler as RedteamAgentHandler, "prompt", "sess-5", 7);
    expect(handler).toHaveBeenCalledWith("prompt", "sess-5", 7);
  });

  it("does not define/require any instanceof or BaseTask gate in this file", () => {
    const source = readFileSync(join(__dirname, "..", "task.ts"), "utf-8");
    // Strip comments (which may reference BaseTask/instanceof only to
    // document the intentional divergence from src/simulation) before
    // asserting no executable instanceof/BaseTask gate exists.
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/instanceof/);
    expect(codeOnly).not.toMatch(/BaseTask/);
  });
});
