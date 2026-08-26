// psql wrapper: run a query against the local aventic-gx Supabase cluster,
// return rows as parsed JSON. No driver dependency — psql is the client.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const ENV = "/home/jessica/src/aventic/aventic-gx/local/supabase/.env";

export function password() {
  if (process.env.SPEC_DB_PASSWORD) return process.env.SPEC_DB_PASSWORD;
  if (!existsSync(ENV)) throw new Error(`no db password: ${ENV} missing (start the local stack)`);
  const line = readFileSync(ENV, "utf8").split("\n").find((l) => l.startsWith("POSTGRES_PASSWORD="));
  if (!line) throw new Error(`POSTGRES_PASSWORD missing from ${ENV}`);
  return line.slice("POSTGRES_PASSWORD=".length).trim();
}

export function sql(db, query, opts = {}) {
  return execFileSync(
    "psql",
    ["-h", "127.0.0.1", "-p", "54322", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-tA", "-c", query],
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
    ["-h", "127.0.0.1", "-p", "54322", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"],
    { encoding: "utf8", input: text, maxBuffer: 512 * 1024 * 1024, env: { ...process.env, PGPASSWORD: password() } },
  );
}
