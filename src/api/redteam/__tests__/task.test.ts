import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { executeTask, RedTeamAgentHandler } from "../task";

describe("executeTask", () => {
  it("resolves a plain async function's string return to {output}", async () => {
    const task: RedTeamAgentHandler = async (prompt) => `echo:${prompt}`;
    const result = await executeTask(task, "hello", "sess-1", 0);
    expect(result).toEqual({ output: "echo:hello" });
  });

  it("tolerates a sync function's string return (await on non-Promise is a no-op)", async () => {
    const task: RedTeamAgentHandler = (prompt) => `sync:${prompt}`;
    const result = await executeTask(task, "hi", "sess-2", 1);
    expect(result).toEqual({ output: "sync:hi" });
  });

  it("extracts {message, sessionId} return shape", async () => {
    const task: RedTeamAgentHandler = async () => ({
      message: "the reply",
      sessionId: "override-session",
    });
    const result = await executeTask(task, "prompt", "sess-3", 2);
    expect(result).toEqual({ output: "the reply", sessionId: "override-session" });
  });

  it("extracts {message} without sessionId override", async () => {
    const task: RedTeamAgentHandler = async () => ({ message: "no override" });
    const result = await executeTask(task, "prompt", "sess-4", 0);
    expect(result).toEqual({ output: "no override", sessionId: undefined });
  });

  it("throws on a bad-shape return (number)", async () => {
    const task = (async () => 42) as unknown as RedTeamAgentHandler;
    await expect(executeTask(task, "p", "s", 0)).rejects.toThrow(
      /must return string/,
    );
  });

  it("throws on a bad-shape return (null)", async () => {
    const task = (async () => null) as unknown as RedTeamAgentHandler;
    await expect(executeTask(task, "p", "s", 0)).rejects.toThrow(
      /must return string/,
    );
  });

  it("throws on a bad-shape return (object missing message)", async () => {
    const task = (async () => ({ foo: "bar" })) as unknown as RedTeamAgentHandler;
    await expect(executeTask(task, "p", "s", 0)).rejects.toThrow(
      /must return string/,
    );
  });

  it("passes turnIndex as the third positional argument to the task", async () => {
    const task = vi.fn(async (_prompt: string, _sessionId: string, _turnIndex: number) => "ok");
    await executeTask(task as RedTeamAgentHandler, "prompt", "sess-5", 7);
    expect(task).toHaveBeenCalledWith("prompt", "sess-5", 7);
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
