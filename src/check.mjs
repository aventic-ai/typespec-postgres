#!/usr/bin/env node
// The drift check: does the spec produce the database the migrations did?
//   pgspec-check [spec/db/main.tsp] [--keep] [--platform=supabase]
//   pgspec-check [spec/db/main.tsp] [--keep] --platform=postgres --owner=<role> --roles=<role>[,<role>...]
// exit: 0 clean · 1 contract drift (gate) · 2 impl drift only (mirror)
//       3 cannot check, for the reason it prints: a bad flag, a spec the emitter
//         refuses, a shadow that does not build, or a job list it cannot read
// On plain Postgres the login builds the shadow as --owner, so it must be able
// to SET ROLE to it.
// debug artifacts (emitted.sql, problems.json) land in SPEC_DEBUG_DIR when set.
import { readCatalog } from "./reader.mjs";
import { emit } from "./emitter.mjs";
import { platformNamed } from "./platform.mjs";
import { diff, projectionProblems, report } from "./differ.mjs";
import { sql, script, liveDb } from "./db.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SHADOW = "pgspec_shadow";
const CANNOT_CHECK = 3;

/** Runs the check and returns its exit code; throws when it cannot check. */
async function check() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      keep: { type: "boolean", default: false },
      platform: { type: "string", default: "supabase" },
      owner: { type: "string" },
      roles: { type: "string" },
    },
  });
  const platform = platformNamed(values.platform, values);
  const specMain = positionals[0] ?? "spec/db/main.tsp";
  const debugDir = process.env.SPEC_DEBUG_DIR;

  // the spec says which schemas are its own, so it compiles before either catalog is read
  console.error("compiling spec + emitting DDL ...");
  const { ddl, cron, projections, schemas } = await emit(specMain, { platform });
  if (debugDir) writeFileSync(join(debugDir, "emitted.sql"), ddl);

  console.error(`reading live catalog (${schemas.join(", ")}) ...`);
  const live = readCatalog(liveDb(), { cron: true, schemas, platform });
  const jobs = Object.keys(cron);
  if (live.cron === null && jobs.length) {
    throw new Error(
      `the spec schedules ${jobs.join(", ")}, and ${liveDb()} has no pg_cron job list to read: pg_cron keeps it in ` +
      "one database of the cluster",
    );
  }

  console.error("building shadow ...");
  sql("postgres", `DROP DATABASE IF EXISTS ${SHADOW}`);
  sql("postgres", `CREATE DATABASE ${SHADOW}`);
  try {
    script(SHADOW, platform.prelude(SHADOW) + ddl);
    console.error("reading shadow catalog ...");
    const shadow = readCatalog(SHADOW, { cron: false, schemas, platform });
    // declared must equal produced before drift against live is meaningful
    const self = projectionProblems(projections, shadow.views);
    if (self.length) {
      console.log(report(self));
      console.error("spec disagrees with itself — fix declared view projections first");
      return 1;
    }
    shadow.cron = cron;   // cron can't round-trip (pg_cron is one-db-per-cluster); compare spec-side directly
    const problems = diff(shadow, live);
    if (debugDir) writeFileSync(join(debugDir, "problems.json"), JSON.stringify(problems, null, 1));
    console.log(report(problems));
    return problems.some((p) => p.layer === "contract") ? 1 : problems.length ? 2 : 0;
  } finally {
    if (!values.keep) sql("postgres", `DROP DATABASE IF EXISTS ${SHADOW}`);
    else console.error(`shadow kept: ${SHADOW}`);
  }
}

try {
  process.exitCode = await check();
} catch (error) {
  // where psql stopped, it has printed its own error already
  console.error(`pgspec-check: ${error.stderr ? "psql stopped on the error above" : error.message}`);
  process.exitCode = CANNOT_CHECK;
}
