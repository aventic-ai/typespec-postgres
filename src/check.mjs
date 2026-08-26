#!/usr/bin/env node
// The drift check: does the spec produce the database the migrations did?
//   pgspec-check [spec/db/main.tsp] [--keep]
// exit: 0 clean · 1 contract drift (gate) · 2 impl drift only (mirror)
// debug artifacts (emitted.sql, problems.json) land in SPEC_DEBUG_DIR when set.
import { readCatalog } from "./reader.mjs";
import { emit } from "./emitter.mjs";
import { prelude } from "./prelude.mjs";
import { diff, projectionProblems, report } from "./differ.mjs";
import { sql, script, liveDb } from "./db.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SHADOW = "pgspec_shadow";
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const specMain = args.find((a) => !a.startsWith("--")) ?? "spec/db/main.tsp";
const debugDir = process.env.SPEC_DEBUG_DIR;

console.error("reading live catalog ...");
const live = readCatalog(liveDb(), { cron: true });

console.error("compiling spec + emitting DDL ...");
const { ddl, cron, projections } = await emit(specMain);
if (debugDir) writeFileSync(join(debugDir, "emitted.sql"), ddl);

console.error("building shadow ...");
sql("postgres", `DROP DATABASE IF EXISTS ${SHADOW}`);
sql("postgres", `CREATE DATABASE ${SHADOW}`);
try {
  script(SHADOW, prelude(SHADOW));
  script(SHADOW, ddl);
  console.error("reading shadow catalog ...");
  const shadow = readCatalog(SHADOW, { cron: false });
  // declared must equal produced before drift against live is meaningful
  const self = projectionProblems(projections, shadow.views);
  if (self.length) {
    console.log(report(self));
    console.error("spec disagrees with itself — fix declared view projections first");
    process.exitCode = 1;
  } else {
    shadow.cron = cron;   // cron can't round-trip (pg_cron is one-db-per-cluster); compare spec-side directly
    const problems = diff(shadow, live);
    if (debugDir) writeFileSync(join(debugDir, "problems.json"), JSON.stringify(problems, null, 1));
    console.log(report(problems));
    // 0 clean · 1 contract drift (gate) · 2 impl drift only (mirror)
    process.exitCode = problems.some((p) => p.layer === "contract") ? 1 : problems.length ? 2 : 0;
  }
} finally {
  if (!keep) sql("postgres", `DROP DATABASE IF EXISTS ${SHADOW}`);
  else console.error(`shadow kept: ${SHADOW}`);
}
