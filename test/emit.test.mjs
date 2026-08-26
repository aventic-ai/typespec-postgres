import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { emit } from "../src/emitter.mjs";

const LIB = fileURLToPath(new URL("../lib/main.tsp", import.meta.url));

function specDir(body) {
  const dir = mkdtempSync(join(tmpdir(), "pgspec-emit-"));
  const lib = relative(dir, LIB).replaceAll("\\", "/");
  writeFileSync(join(dir, "main.tsp"), `import "${lib.startsWith(".") ? lib : "./" + lib}";\n${body}`);
  return join(dir, "main.tsp");
}

describe("emit layering enforcement", () => {
  test("clean_spec_emits_ddl", async () => {
    const { ddl } = await emit(specDir(`namespace \`public\`;\nmodel probes { id: uuid; }\n`));
    expect(ddl).toContain("CREATE TABLE public.probes");
  });

  test("layering_violation_rejected_like_a_compile_error", async () => {
    const main = specDir(
      `namespace \`public\`;\nmodel probes { id: uuid; }\n` +
      `@@index(probes, "probes_id_idx on (id)");\n`,
    );
    expect(emit(main)).rejects.toThrow(/does not lint.*@index/s);
  });
});
