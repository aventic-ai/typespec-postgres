// The drift check: does the spec produce the database the migrations did?
//   node src/check.mjs [--keep]
import { readCatalog } from "./reader.mjs";
import { emit } from "./emitter.mjs";
import { PRELUDE } from "./prelude.mjs";
import { diff, report } from "./differ.mjs";
import { sql, script } from "./db.mjs";
import { writeFileSync } from "node:fs";

const SHADOW = "pgspec_shadow";
const keep = process.argv.includes("--keep");

console.error("reading live catalog ...");
const live = readCatalog("postgres", { cron: true });

console.error("compiling spec + emitting DDL ...");
const { ddl, cron } = await emit("spec/db/main.tsp");
writeFileSync("/tmp/claude-1000/-home-jessica-src-aventic/f9ca0b58-bfeb-4681-a462-263cba818fc1/scratchpad/emitted.sql", ddl);

console.error("building shadow ...");
sql("postgres", `DROP DATABASE IF EXISTS ${SHADOW}`);
sql("postgres", `CREATE DATABASE ${SHADOW}`);
try {
  script(SHADOW, PRELUDE);
  script(SHADOW, ddl);
  console.error("reading shadow catalog ...");
  const shadow = readCatalog(SHADOW, { cron: false });
  shadow.cron = cron;   // cron can't round-trip (pg_cron is one-db-per-cluster); compare spec-side directly
  const problems = diff(shadow, live);
  writeFileSync(
    "/tmp/claude-1000/-home-jessica-src-aventic/f9ca0b58-bfeb-4681-a462-263cba818fc1/scratchpad/problems.json",
    JSON.stringify(problems, null, 1),
  );
  console.log(report(problems));
  // 0 clean · 1 contract drift (gate) · 2 impl drift only (mirror)
  process.exitCode = problems.some((p) => p.layer === "contract") ? 1 : problems.length ? 2 : 0;
} finally {
  if (!keep) sql("postgres", `DROP DATABASE IF EXISTS ${SHADOW}`);
  else console.error(`shadow kept: ${SHADOW}`);
}
