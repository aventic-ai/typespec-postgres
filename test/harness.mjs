// Test harness: compile an in-memory spec fixture and lint its layering,
// write one for the emitter, and tell whether a database is there to read.
// Fixtures are {filename: text}; a main.tsp importing the pg library and
// every fixture file is generated, so each test states only its spec.
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { compile, NodeHost } from "@typespec/compiler";
import { lintLayers } from "../src/lint.mjs";
import { rows } from "../src/db.mjs";
import { nameArraySql } from "../src/schemas.mjs";

const LIB = fileURLToPath(new URL("../lib/main.tsp", import.meta.url));
const CHECK = fileURLToPath(new URL("../src/check.mjs", import.meta.url));

/** Runs pgspec-check with `args`, and `env` over this process's; returns its exit status and output. */
export function runCheck(args, env = {}) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [CHECK, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status, stdout, stderr };
}

export async function compileSpec(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pgspec-test-")));
  for (const [name, text] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  const lib = relative(dir, LIB).replaceAll("\\", "/");
  const main = join(dir, "main.tsp");
  writeFileSync(main, [
    `import "${lib.startsWith(".") ? lib : "./" + lib}";`,
    ...Object.keys(files).map((n) => `import "./${n}";`),
  ].join("\n"));
  const program = await compile(NodeHost, main, {});
  const errors = program.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) {
    throw new Error(`fixture does not compile:\n${errors.map((e) => `${e.code}: ${e.message}`).join("\n")}`);
  }
  return { program, dir };
}

export async function lintSpec(files) {
  const { program } = await compileSpec(files);
  return lintLayers(program);
}

/** Writes main.tsp and the SQL bodies it reads; `files` is {relative path: text}. */
export function specDir(body, files = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pgspec-emit-")));
  const lib = relative(dir, LIB).replaceAll("\\", "/");
  writeFileSync(join(dir, "main.tsp"), `import "${lib.startsWith(".") ? lib : "./" + lib}";\n${body}`);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return join(dir, "main.tsp");
}

// A test that reads a real catalog runs only when the SPEC_DB_* cluster
// answers, and only when the cluster carries the roles its fixture grants to,
// as pgspec-check requires, or lets the test make its own.
export function clusterAnswers() {
  if (!process.env.SPEC_DB_PASSWORD) return false;
  try {
    rows("postgres", "SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export const clusterHasRoles = (roles) =>
  clusterAnswers() && rows("postgres", `SELECT rolname FROM pg_roles WHERE rolname = ANY(${nameArraySql(roles)})`).length === roles.length;

export const canCreateRoles = () =>
  clusterAnswers() && rows("postgres", "SELECT rolsuper OR rolcreaterole AS can FROM pg_roles WHERE rolname = current_user")[0].can;
