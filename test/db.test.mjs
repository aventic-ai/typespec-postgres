import { describe, test, expect } from "bun:test";
import { password, liveDb } from "../src/db.mjs";

describe("db env boundary", () => {
  test("password_requires_env_never_guesses_files", () => {
    delete process.env.SPEC_DB_PASSWORD;
    expect(() => password()).toThrow(/SPEC_DB_PASSWORD/);
  });

  test("password_reads_env", () => {
    process.env.SPEC_DB_PASSWORD = "hunter2";
    expect(password()).toBe("hunter2");
    delete process.env.SPEC_DB_PASSWORD;
  });

  test("live_db_defaults_to_postgres", () => {
    delete process.env.SPEC_DB_NAME;
    expect(liveDb()).toBe("postgres");
    process.env.SPEC_DB_NAME = "other";
    expect(liveDb()).toBe("other");
    delete process.env.SPEC_DB_NAME;
  });
});
