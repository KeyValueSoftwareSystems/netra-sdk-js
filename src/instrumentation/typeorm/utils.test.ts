/** JS-SEC-016: TypeORM query parameter values are opt-in. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { setTraceContentEnabled } from "../utils";
import { setQueryAttributes } from "./utils";

function record(sql: string, parameters?: any[]) {
  const attrs: Record<string, unknown> = {};
  const span: any = { setAttribute: (k: string, v: unknown) => { attrs[k] = v; } };
  setQueryAttributes(span, sql, parameters);
  return attrs;
}

describe("TypeORM query attributes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setTraceContentEnabled(undefined);
  });

  const SQL = "UPDATE users SET reset_token = $1 WHERE email = $2";
  const PARAMS = ["tok_SECRET", "alice@example.com"];

  it("records the statement and parameter count, not the values, by default", () => {
    setTraceContentEnabled(true);
    const attrs = record(SQL, PARAMS);
    expect(attrs["db.statement"]).toBe(SQL);
    expect(attrs["db.statement.parameters.count"]).toBe(2);
    expect(attrs["db.statement.parameters"]).toBeUndefined();
    expect(JSON.stringify(attrs)).not.toMatch(/SECRET|alice/);
  });

  it("records values only with NETRA_TRACE_DB_PARAMETERS=true and content tracing on", () => {
    vi.stubEnv("NETRA_TRACE_DB_PARAMETERS", "true");
    setTraceContentEnabled(true);
    expect(record(SQL, PARAMS)["db.statement.parameters"]).toBe(JSON.stringify(PARAMS));

    setTraceContentEnabled(false);
    expect(record(SQL, PARAMS)["db.statement.parameters"]).toBeUndefined();
  });
});
