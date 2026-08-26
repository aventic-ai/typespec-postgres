import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { emit } from "../src/emitter.mjs";
import { projectionProblems } from "../src/differ.mjs";

const LIB = fileURLToPath(new URL("../lib/main.tsp", import.meta.url));

async function emitView(model) {
  const dir = mkdtempSync(join(tmpdir(), "pgspec-proj-"));
  const lib = relative(dir, LIB).replaceAll("\\", "/");
  mkdirSync(join(dir, "views"));
  writeFileSync(join(dir, "views", "v.sql"), "select id from probes\n");
  writeFileSync(
    join(dir, "main.tsp"),
    `import "${lib.startsWith(".") ? lib : "./" + lib}";\nnamespace \`public\`;\nmodel probes { id: uuid; }\n${model}`,
  );
  return emit(join(dir, "main.tsp"));
}

describe("declared projections", () => {
  test("emit_returns_declared_view_projections", async () => {
    const { projections } = await emitView(
      `@security_invoker\n@view\nmodel v { id: uuid; created_at?: timestamptz; }`,
    );
    expect(projections).toEqual({
      v: [["id", "uuid"], ["created_at", "timestamp with time zone"]],
    });
  });

  test("matching_projection_yields_no_problems", () => {
    expect(
      projectionProblems(
        { v: [["id", "uuid"]] },
        { v: { columns: [["id", "uuid"]] } },
      ),
    ).toEqual([]);
  });

  test("lying_type_flags_contract_severity", () => {
    const problems = projectionProblems(
      { v: [["id", "uuid"]] },
      { v: { columns: [["id", "text"]] } },
    );
    expect(problems.length).toBe(1);
    expect(problems[0].layer).toBe("contract");
    expect(problems[0].what).toContain("projection");
  });

  test("wrong_order_flags", () => {
    const problems = projectionProblems(
      { v: [["a", "uuid"], ["b", "text"]] },
      { v: { columns: [["b", "text"], ["a", "uuid"]] } },
    );
    expect(problems.length).toBe(1);
  });

  test("view_missing_from_shadow_flags", () => {
    const problems = projectionProblems({ v: [["id", "uuid"]] }, {});
    expect(problems.length).toBe(1);
    expect(problems[0].layer).toBe("contract");
  });
});
