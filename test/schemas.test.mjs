import { describe, test, expect } from "bun:test";
import { compileSpec } from "./harness.mjs";
import { catalogKey, declaredSchemas, schemaArraySql } from "../src/schemas.mjs";

const PUBLIC = "namespace `public`;\nmodel orgs { id: uuid; }\n";

async function schemasOf(files) {
  const { program } = await compileSpec(files);
  return declaredSchemas(program.getGlobalNamespaceType());
}

describe("which namespaces are schemas", () => {
  test("public_alone_is_the_whole_list", async () => {
    expect(await schemasOf({ "public.tsp": PUBLIC })).toEqual(["public"]);
  });

  test("another_namespace_is_a_schema_the_spec_owns", async () => {
    expect(await schemasOf({
      "public.tsp": PUBLIC,
      "chat.tsp": "namespace chat {\n  using `public`;\n  model rooms { id: uuid; }\n}\n",
    })).toEqual(["public", "chat"]);
  });

  test("the_cron_job_list_is_not_a_schema", async () => {
    expect(await schemasOf({
      "public.tsp": PUBLIC,
      "cron.tsp": 'namespace cron;\n@schedule("17 3 * * *")\n@command("select 1")\nop nightly(): void;\n',
    })).toEqual(["public"]);
  });

  test("a_platform_schema_is_never_the_specs_to_create", async () => {
    const external = (name, model) => `namespace ${name} {\n  @external\n  model ${model} {}\n}\n`;
    expect(await schemasOf({
      "public.tsp": PUBLIC,
      "external.tsp": external("storage", "objects") + external("realtime", "messages") +
        external("auth", "users") + external("extensions", "anything"),
    })).toEqual(["public"]);
  });

  // The library declares `public` for its own types, so only a spec that
  // never imports it can lack the namespace; no compiled fixture can.
  test("a_spec_without_public_is_refused", () => {
    const withoutLibrary = { namespaces: new Map([["TypeSpec", {}], ["chat", {}]]) };
    expect(() => declaredSchemas(withoutLibrary)).toThrow(/no `public` namespace/);
  });

  test("a_schema_name_must_be_a_plain_identifier", async () => {
    const files = { "public.tsp": PUBLIC, "odd.tsp": "namespace `Team-Chat` {\n  model rooms {}\n}\n" };
    expect(schemasOf(files)).rejects.toThrow(/plain identifier.*Team-Chat/s);
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

describe("schema list as a SQL array", () => {
  test("names_become_an_array_literal", () => {
    expect(schemaArraySql(["public", "chat"])).toBe("'{public,chat}'");
  });

  test("a_name_that_could_leave_the_literal_is_refused", () => {
    expect(() => schemaArraySql(["public", "x}'; drop schema public; --"])).toThrow(/plain identifier/);
  });
});
