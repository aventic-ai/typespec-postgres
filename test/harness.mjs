// Test harness: compile an in-memory spec fixture and lint its layering.
// Fixtures are {filename: text}; a main.tsp importing the pg library and
// every fixture file is generated, so each test states only its spec.
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, NodeHost } from "@typespec/compiler";
import { lintLayers } from "../src/lint.mjs";

const LIB = fileURLToPath(new URL("../lib/main.tsp", import.meta.url));

export async function compileSpec(files) {
  const dir = mkdtempSync(join(tmpdir(), "pgspec-test-"));
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
