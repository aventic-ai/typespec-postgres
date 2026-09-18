import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { password, liveDb } from "../src/db.mjs";

const BOUNDARY = ["SPEC_DB_PASSWORD", "SPEC_DB_NAME"];

describe("db env boundary", () => {
  // Every test file shares this process, and the reader test reaches its
  // cluster through these variables: leave them as they were found.
  let found;
  beforeEach(() => {
    found = BOUNDARY.map((name) => process.env[name]);
  });
  afterEach(() => {
    BOUNDARY.forEach((name, i) => {
      if (found[i] === undefined) delete process.env[name];
      else process.env[name] = found[i];
    });
  });

  test("password_requires_env_never_guesses_files", () => {
    delete process.env.SPEC_DB_PASSWORD;
    expect(() => password()).toThrow(/SPEC_DB_PASSWORD/);
  });

  test("password_reads_env", () => {
    process.env.SPEC_DB_PASSWORD = "hunter2";
    expect(password()).toBe("hunter2");
  });

  test("live_db_defaults_to_postgres", () => {
    delete process.env.SPEC_DB_NAME;
    expect(liveDb()).toBe("postgres");
    process.env.SPEC_DB_NAME = "other";
    expect(liveDb()).toBe("other");
  });
});
