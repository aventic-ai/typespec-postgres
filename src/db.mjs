// psql wrapper: run queries against the Postgres reached through the
// SPEC_DB_* env boundary, return rows as parsed JSON. No driver
// dependency — psql is the client. The consumer owns knowing where its
// credentials live; the tool never guesses from files.
import { execFileSync } from "node:child_process";

const host = () => process.env.SPEC_DB_HOST ?? "127.0.0.1";
const port = () => process.env.SPEC_DB_PORT ?? "54322";
const user = () => process.env.SPEC_DB_USER ?? "postgres";

/** The live database the spec is checked against. */
export const liveDb = () => process.env.SPEC_DB_NAME ?? "postgres";

export function password() {
  const p = process.env.SPEC_DB_PASSWORD;
  if (!p) throw new Error("SPEC_DB_PASSWORD is not set");
  return p;
}

export function sql(db, query, opts = {}) {
  return execFileSync(
    "psql",
    ["-h", host(), "-p", port(), "-U", user(), "-d", db, "-v", "ON_ERROR_STOP=1", "-tA", "-c", query],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, env: { ...process.env, PGPASSWORD: password() }, ...opts },
  );
}

/** Query returning rows as JSON objects. */
export function rows(db, query) {
  const out = sql(db, `SELECT coalesce(json_agg(t), '[]'::json) FROM (${query}) t`);
  return JSON.parse(out.trim() || "[]");
}

/** Run a multi-statement SQL script via stdin. Throws with stderr on failure. */
export function script(db, text) {
  return execFileSync(
    "psql",
    ["-h", host(), "-p", port(), "-U", user(), "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"],
    { encoding: "utf8", input: text, maxBuffer: 512 * 1024 * 1024, env: { ...process.env, PGPASSWORD: password() } },
  );
}
