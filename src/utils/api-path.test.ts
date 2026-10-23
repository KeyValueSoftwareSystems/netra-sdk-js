import { describe, expect, it } from "vitest";
import { apiPath } from "./api-path";

describe("apiPath", () => {
  it("leaves plain IDs unchanged", () => {
    expect(apiPath`/usage/sessions/${"abc-123"}`).toBe("/usage/sessions/abc-123");
  });

  it("encodes characters that would change the path or query", () => {
    expect(apiPath`/usage/sessions/${"../tenants/acme"}`).toBe(
      "/usage/sessions/..%2Ftenants%2Facme",
    );
    expect(apiPath`/usage/sessions/${"abc?x=1"}`).toBe("/usage/sessions/abc%3Fx%3D1");
    expect(apiPath`/usage/sessions/${"a#b"}`).toBe("/usage/sessions/a%23b");
  });

  it("keeps the request on the intended endpoint after URL parsing", () => {
    const url = new URL(apiPath`/usage/sessions/${"../tenants/acme"}`, "https://api.example.com");
    expect(url.pathname).toBe("/usage/sessions/..%2Ftenants%2Facme");
  });

  it("encodes every interpolated segment", () => {
    expect(apiPath`/evaluations/run/${"r/1"}/item/${"i 2"}/status`).toBe(
      "/evaluations/run/r%2F1/item/i%202/status",
    );
  });

  it.each(["", ".", "..", undefined, null])("rejects %j", (value) => {
    expect(() => apiPath`/usage/sessions/${value}`).toThrow(/Invalid path segment/);
  });
});
