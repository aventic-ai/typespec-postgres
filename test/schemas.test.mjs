import { describe, test, expect } from "bun:test";
import { compileSpec } from "./harness.mjs";
import { SUPABASE, plainPostgres } from "../src/platform.mjs";
import { catalogKey, declaredSchemas, nameArraySql } from "../src/schemas.mjs";

const PUBLIC = "namespace `public`;\nmodel orgs { id: uuid; }\n";
const inside = (name, body) => `namespace ${name} {\n  using \`public\`;\n  ${body}\n}\n`;
const PLAIN = plainPostgres({ owner: "app_owner", roles: ["app_runtime"] });

async function schemasOf(files, platform = SUPABASE) {
  const { program } = await compileSpec(files);
  return declaredSchemas(program.getGlobalNamespaceType(), platform);
}

describe("which namespaces are schemas", () => {
  test("public_alone_is_the_whole_list", async () => {
    expect(await schemasOf({ "public.tsp": PUBLIC })).toEqual(["public"]);
  });

  test("a_namespace_that_owns_a_table_is_a_schema", async () => {
    expect(await schemasOf({
      "public.tsp": PUBLIC,
      "chat.tsp": inside("chat", "model rooms { id: uuid; }"),
    })).toEqual(["public", "chat"]);
  });

  test("an_enum_or_a_function_is_enough_to_own", async () => {
    expect(await schemasOf({
      "public.tsp": PUBLIC,
      "moods.tsp": inside("moods", "enum mood { calm, busy }"),
      "fns.tsp": inside("fns", '@function("sql") op one(): integer;'),
    })).toEqual(["public", "moods", "fns"]);
  });

  test("a_namespace_that_owns_nothing_is_not_a_schema", async () => {
    expect(await schemasOf({
      "public.tsp": PUBLIC,
      "helpers.tsp": "namespace Shared {\n  alias Id = string;\n}\nnamespace types {\n  alias label = string;\n}\n",
    })).toEqual(["public"]);
  });

  test("a_namespace_of_tables_another_system_owns_is_not_a_schema", async () => {
    expect(await schemasOf({
      "public.tsp": PUBLIC,
      "external.tsp": inside("vault", "@external\n  model secrets { id: uuid; }"),
    })).toEqual(["public"]);
  });

  test("the_cron_job_list_is_not_a_schema", async () => {
    expect(await schemasOf({
      "public.tsp": PUBLIC,
      "cron.tsp": 'namespace cron;\n@schedule("17 3 * * *")\n@command("select 1")\nop nightly(): void;\n',
    })).toEqual(["public"]);
  });

  test("a_platform_schema_cannot_own_a_table", async () => {
    const files = { "public.tsp": PUBLIC, "auth.tsp": inside("auth", "model users { id: uuid; }") };
    expect(schemasOf(files)).rejects.toThrow(/auth.*platform schema.*@external/s);
  });

  test("on_plain_postgres_auth_is_a_schema_like_any_other", async () => {
    const files = { "auth.tsp": inside("auth", "model users { id: uuid; }") };
    expect(await schemasOf(files, PLAIN)).toEqual(["public", "auth"]);
  });

  // The prelude creates its stand-ins by hand, so nothing but this ties the
  // list Supabase declares to the statements it runs.
  test("the_platform_schemas_are_exactly_the_ones_the_prelude_creates", () => {
    const created = [...SUPABASE.prelude("shadow").matchAll(/^CREATE SCHEMA (\w+);/gm)].map((m) => m[1]);
    expect(created.sort()).toEqual([...SUPABASE.schemas].sort());
  });


  // Postgres schemas do not nest, and nothing reads a nested namespace: left
  // alone, its tables would compile, lint and never be emitted.
  test("a_namespace_inside_another_is_refused", async () => {
    const files = { "public.tsp": PUBLIC, "nested.tsp": inside("chat.inner", "model rooms { id: uuid; }") };
    expect(schemasOf(files)).rejects.toThrow(/chat\.inner/);
  });

  // The library declares `public` for its own types, so only a spec that
  // never imports it can lack the namespace; no compiled fixture can.
  test("a_spec_without_public_is_refused", () => {
    const empty = { models: new Map(), enums: new Map(), operations: new Map(), namespaces: new Map() };
    const withoutLibrary = { namespaces: new Map([["TypeSpec", empty], ["chat", empty]]) };
    expect(() => declaredSchemas(withoutLibrary, SUPABASE)).toThrow(/no `public` namespace/);
  });

  test("a_schema_name_must_be_a_plain_identifier", async () => {
    const files = { "public.tsp": PUBLIC, "odd.tsp": inside("`Team-Chat`", "model rooms { id: uuid; }") };
    expect(schemasOf(files)).rejects.toThrow(/plain identifier.*Team-Chat/s);
  });
});

// Postgres 15 and later close `public` to every role but the database's owner,
// so the role migrations run as could not create there.
describe("where the platform keeps public empty", () => {
  test("a_table_in_public_is_refused_by_name", async () => {
    await expect(schemasOf({ "public.tsp": PUBLIC }, PLAIN)).rejects.toThrow(/^public cannot hold orgs: the platform keeps it empty/);
  });

  test("a_function_in_the_cron_job_list_lands_in_public_and_is_refused", async () => {
    const files = { "cron.tsp": 'namespace cron;\n@function("sql") op tidy(): void;\n' };
    await expect(schemasOf(files, PLAIN)).rejects.toThrow(/^public cannot hold tidy/);
  });

  test("objects_in_schemas_of_their_own_are_declared", async () => {
    const files = { "chat.tsp": inside("chat", "model rooms { id: uuid; }") };
    expect(await schemasOf(files, PLAIN)).toEqual(["public", "chat"]);
  });
});

describe("catalog keys", () => {
  test("public_objects_keep_their_bare_name", () => {
    expect(catalogKey("public", "orgs")).toBe("orgs");
  });

  test("objects_elsewhere_carry_their_schema", () => {
    expect(catalogKey("chat", "rooms")).toBe("chat.rooms");
  });
});

describe("names as a SQL array", () => {
  test("names_become_an_array_literal", () => {
    expect(nameArraySql(["public", "chat"])).toBe("'{public,chat}'");
  });

  test("a_table_keeps_its_schema", () => {
    expect(nameArraySql(["storage.objects"])).toBe("'{storage.objects}'");
  });

  test("a_name_that_could_leave_the_literal_is_refused", () => {
    expect(() => nameArraySql(["public", "x}'; drop schema public; --"])).toThrow(/plain identifier/);
    expect(() => nameArraySql(["a.b.c"])).toThrow(/plain identifier: "a.b.c"/);
  });
});
