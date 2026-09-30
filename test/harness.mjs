// Test harness: compile an in-memory spec fixture and lint its layering,
// write one for the emitter, and tell whether a database is there to read.
// Fixtures are {filename: text}; a main.tsp importing the pg library and
// every fixture file is generated, so each test states only its spec.
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, NodeHost } from "@typespec/compiler";
import { lintLayers } from "../src/lint.mjs";
import { rows } from "../src/db.mjs";

const LIB = fileURLToPath(new URL("../lib/main.tsp", import.meta.url));

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
// answers and carries the PostgREST roles its fixture grants to, as
// pgspec-check requires.
export function clusterHasPostgrestRoles() {
  if (!process.env.SPEC_DB_PASSWORD) return false;
  try {
    const found = rows("postgres", "SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')");
    return found.length === 3;
  } catch {
    return false;
  }
}
