import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "./version";

describe("SDK_VERSION", () => {
  it("matches the version in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
