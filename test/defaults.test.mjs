import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { emit } from "../src/emitter.mjs";

const LIB = fileURLToPath(new URL("../lib/main.tsp", import.meta.url));

async function ddlOf(body) {
  const dir = mkdtempSync(join(tmpdir(), "pgspec-def-"));
  mkdirSync(join(dir, "fn"));
  writeFileSync(join(dir, "fn", "f.sql"), "select 'x'\n");
  const lib = relative(dir, LIB).replaceAll("\\", "/");
  writeFileSync(join(dir, "main.tsp"), `import "${lib.startsWith(".") ? lib : "./" + lib}";\nnamespace \`public\`;\n${body}`);
  return (await emit(join(dir, "main.tsp"))).ddl;
}

describe("value-position defaults", () => {
  test("sql_default_emits_verbatim", async () => {
    const ddl = await ddlOf(`model t { created_at: timestamptz = sql.of("now()"); }`);
    expect(ddl).toContain("created_at timestamp with time zone DEFAULT now() NOT NULL");
  });

  test("string_literal_default_emits_quoted", async () => {
    const ddl = await ddlOf(`model t { status: text = "pending"; }`);
    expect(ddl).toContain("status text DEFAULT 'pending' NOT NULL");
  });

  test("numeric_and_boolean_literals_emit", async () => {
    const ddl = await ddlOf(`model t { n: integer = 0; ok: boolean = true; }`);
    expect(ddl).toContain("n integer DEFAULT 0 NOT NULL");
    expect(ddl).toContain("ok boolean DEFAULT true NOT NULL");
  });

  test("enum_member_default_emits_cast", async () => {
    const ddl = await ddlOf(`enum mood { happy, sad }\nmodel t { m: mood = mood.happy; }`);
    expect(ddl).toContain("m mood DEFAULT 'happy'::mood NOT NULL");
  });

  test("array_escape_emits", async () => {
    const ddl = await ddlOf(`model t { tags: text[] | sql = sql.of("'{}'::text[]"); }`);
    expect(ddl).toContain("tags text[] DEFAULT '{}'::text[] NOT NULL");
  });

  test("nextval_default_still_creates_sequence", async () => {
    const ddl = await ddlOf(`model t { n: integer = sql.of("nextval('public.t_n_seq'::regclass)"); }`);
    expect(ddl).toContain("CREATE SEQUENCE public.t_n_seq;");
  });

  test("param_sql_default_and_optional_null", async () => {
    const ddl = await ddlOf(
      `@function("sql stable") op f(a?: text, b: timestamptz = sql.of("now()"), c: integer = 5): text;\n`,
    );
    expect(ddl).toContain("a text DEFAULT NULL");
    expect(ddl).toContain("b timestamp with time zone DEFAULT now()");
    expect(ddl).toContain("c integer DEFAULT 5");
  });
});
