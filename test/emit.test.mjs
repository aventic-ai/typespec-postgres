import { describe, test, expect, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { emit } from "../src/emitter.mjs";

const LIB = fileURLToPath(new URL("../lib/main.tsp", import.meta.url));

/** Writes main.tsp and the SQL bodies it reads; `files` is {relative path: text}. */
function specDir(body, files = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pgspec-emit-")));
  const lib = relative(dir, LIB).replaceAll("\\", "/");
  writeFileSync(join(dir, "main.tsp"), `import "${lib.startsWith(".") ? lib : "./" + lib}";\n${body}`);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return join(dir, "main.tsp");
}

describe("emit layering enforcement", () => {
  test("clean_spec_emits_ddl", async () => {
    const { ddl } = await emit(specDir(`namespace \`public\`;\nmodel probes { id: uuid; }\n`));
    expect(ddl).toContain("CREATE TABLE public.probes");
  });

  test("layering_violation_rejected_like_a_compile_error", async () => {
    const main = specDir(
      `namespace \`public\`;\n@@index(probes, "probes_id_idx on (id)");\n` +
      `model probes { id: uuid; }\n`,
    );
    expect(emit(main)).rejects.toThrow(/does not lint.*@@index/s);
  });
});

const TWO_SCHEMAS = `
namespace \`public\` {
  @pk("id")
  model orgs {
    id: uuid;
    n: bigint = sql.of("nextval('orgs_n_seq'::regclass)");
  }
  @function("plpgsql") op touch_updated_at(): trigger;
}

namespace chat {
  using \`public\`;

  enum mood { calm, busy }

  @pk("id")
  model rooms {
    id: uuid;
    @references(orgs.id, "ON DELETE CASCADE")
    org_id: uuid;
    is_open: boolean;
    feeling: mood = mood.calm;
    n: bigint = sql.of("nextval('chat.rooms_n_seq'::regclass)");
  }

  @security_invoker
  @view
  model open_rooms { id: uuid; }

  @function("sql stable") op room_count(): bigint;
}

// ── security ──────────────────────────────────────────
@@rls(chat.rooms);
@@grant(chat.rooms, "gx_api", "select");
@@grant(chat.open_rooms, "gx_api", "select");
@@grant(chat.room_count, "gx_api", "execute");
@@policy(chat.rooms, "members read", "for select to authenticated using (true)");

// ── impl ──────────────────────────────────────────────
@@index(chat.rooms, "rooms_org_idx USING btree (org_id)");
@@trigger(chat.rooms, "rooms_touch", "before update for each row", \`public\`.touch_updated_at);
`;

const TWO_SCHEMAS_FILES = {
  "fn/touch_updated_at.sql": "begin return new; end\n",
  "fn/room_count.sql": "select count(*) from chat.rooms\n",
  "views/open_rooms.sql": "select id from chat.rooms where is_open\n",
};

describe("a namespace beside public is a schema of its own", () => {
  let out;
  beforeAll(async () => {
    out = await emit(specDir(TWO_SCHEMAS, TWO_SCHEMAS_FILES));
  });

  test("the_schema_is_created_before_anything_that_lives_in_it", () => {
    expect(out.schemas).toEqual(["public", "chat"]);
    expect(out.ddl).toContain("CREATE SCHEMA chat;");
    expect(out.ddl).not.toContain("CREATE SCHEMA public");
    expect(out.ddl.indexOf("CREATE SCHEMA chat;")).toBeLessThan(out.ddl.indexOf("CREATE TYPE"));
  });

  test("a_table_and_its_facts_carry_the_schema", () => {
    expect(out.ddl).toContain("CREATE TABLE chat.rooms (");
    expect(out.ddl).toContain("ALTER TABLE chat.rooms ENABLE ROW LEVEL SECURITY;");
    expect(out.ddl).toContain("GRANT select ON chat.rooms TO gx_api;");
    expect(out.ddl).toContain('CREATE POLICY "members read" ON chat.rooms\n');
    expect(out.ddl).toContain("CREATE INDEX rooms_org_idx ON chat.rooms USING btree (org_id);");
  });

  test("a_foreign_key_names_the_schema_of_the_table_it_points_at", () => {
    expect(out.ddl).toContain(
      "ALTER TABLE chat.rooms ADD CONSTRAINT rooms_org_id_fkey FOREIGN KEY (org_id) " +
      "REFERENCES public.orgs(id) ON DELETE CASCADE;",
    );
  });

  test("a_function_is_created_revoked_and_granted_in_its_schema", () => {
    expect(out.ddl).toContain("CREATE FUNCTION chat.room_count() RETURNS bigint\n");
    expect(out.ddl).toContain("REVOKE ALL ON FUNCTION chat.room_count() FROM PUBLIC;");
    expect(out.ddl).toContain("GRANT EXECUTE ON FUNCTION chat.room_count() TO gx_api;");
  });

  test("a_trigger_names_the_schema_its_function_lives_in", () => {
    expect(out.ddl).toContain(
      "CREATE TRIGGER rooms_touch before update ON chat.rooms for each row " +
      "EXECUTE FUNCTION public.touch_updated_at();",
    );
  });

  test("an_enum_is_qualified_where_it_is_created_and_where_it_is_used", () => {
    expect(out.ddl).toContain("CREATE TYPE chat.mood AS ENUM ('calm', 'busy');");
    expect(out.ddl).toContain("feeling chat.mood DEFAULT 'calm'::chat.mood NOT NULL");
  });

  test("a_view_and_its_projection_carry_the_schema", () => {
    expect(out.ddl).toContain("CREATE VIEW chat.open_rooms WITH (security_invoker=true) AS\n");
    expect(out.ddl).toContain("GRANT select ON chat.open_rooms TO gx_api;");
    expect(out.projections).toEqual({ "chat.open_rooms": [["id", "uuid"]] });
  });

  test("a_serial_default_creates_its_sequence_in_the_schema_it_names", () => {
    expect(out.ddl).toContain("CREATE SEQUENCE chat.rooms_n_seq;");
    expect(out.ddl).toContain("CREATE SEQUENCE public.orgs_n_seq;");
  });

  // `boolean` is also a compiler builtin: only a `using` inside the namespace
  // block outranks it, which is why the fixture is written in block form.
  test("library_types_resolve_through_a_using_inside_the_block", () => {
    expect(out.ddl).toContain("is_open boolean NOT NULL");
  });
});

describe("public stays what it was", () => {
  test("a_public_only_spec_declares_no_schema", async () => {
    const { ddl, schemas } = await emit(specDir(`namespace \`public\`;\nmodel probes { id: uuid; }\n`));
    expect(schemas).toEqual(["public"]);
    expect(ddl).not.toContain("CREATE SCHEMA");
  });
});

const sameNamedViews = (publicBody, chatBody) => specDir(
  `namespace \`public\` {\n  model probes { id: uuid; }\n  @security_invoker\n  @view("./views/public_v.sql")\n  model v { id: uuid; }\n}\n` +
  `namespace chat {\n  using \`public\`;\n  model rooms { id: uuid; }\n  @security_invoker\n  @view("./views/chat_v.sql")\n  model v { id: uuid; }\n}\n`,
  { "views/public_v.sql": publicBody, "views/chat_v.sql": chatBody },
);

describe("views that share a name across schemas", () => {
  test("both_emit", async () => {
    const { ddl } = await emit(sameNamedViews("select id from probes\n", "select id from chat.rooms\n"));
    expect(ddl).toContain("CREATE VIEW public.v ");
    expect(ddl).toContain("CREATE VIEW chat.v ");
  });

  test("one_waits_for_the_other_it_selects_from", async () => {
    const { ddl } = await emit(sameNamedViews("select id from chat.v\n", "select id from chat.rooms\n"));
    expect(ddl.indexOf("CREATE VIEW chat.v ")).toBeLessThan(ddl.indexOf("CREATE VIEW public.v "));
  });

  test("two_declarations_cannot_read_one_default_body_file", async () => {
    const view = "@security_invoker\n  @view\n  model v { id: uuid; }";
    const main = specDir(
      `namespace \`public\` {\n  model probes { id: uuid; }\n  ${view}\n}\n` +
      `namespace chat {\n  using \`public\`;\n  ${view}\n}\n`,
      { "views/v.sql": "select id from probes\n" },
    );
    expect(emit(main)).rejects.toThrow(/public\.v.*chat\.v.*views\/v\.sql/s);
  });
});

describe("a schema beside public is closed to the PostgREST roles", () => {
  const granting = (declaration, target) => specDir(
    `namespace \`public\` {\n  model probes { id: uuid; }\n}\n` +
    `namespace chat {\n  using \`public\`;\n  ${declaration}\n}\n` +
    `@@grant(chat.${target}, "service_role", "select");\n`,
    { "fn/room_count.sql": "select 1\n", "views/open_rooms.sql": "select 1 as id\n" },
  );

  test.each([
    ["a table", "model rooms { id: uuid; }", "rooms"],
    ["a view", "@security_invoker\n  @view\n  model open_rooms { id: integer; }", "open_rooms"],
    ["a function", '@function("sql stable") op room_count(): bigint;', "room_count"],
  ])("a_grant_on_%s_there_is_refused", async (_kind, declaration, target) => {
    expect(emit(granting(declaration, target))).rejects.toThrow(
      new RegExp(`service_role.*chat\\.${target}.*USAGE`, "s"),
    );
  });
});

describe("declarations outside the spec's own schemas", () => {
  test("a_foreign_key_to_another_systems_table_names_that_schema", async () => {
    const { ddl } = await emit(specDir(
      `namespace vault {\n  using \`public\`;\n  @external\n  model secrets { id: uuid; }\n}\n` +
      `namespace \`public\` {\n  model probes {\n    id: uuid;\n    @references(vault.secrets.id)\n    secret_id: uuid;\n  }\n}\n`,
    ));
    expect(ddl).toContain("REFERENCES vault.secrets(id);");
    expect(ddl).not.toContain("CREATE SCHEMA");
  });

  // Outside `cron` a job's schedule is an impl fact, so the lint wants it as an augment.
  test("two_jobs_cannot_share_a_name", async () => {
    const main = specDir(
      `namespace \`public\` {\n  model probes { id: uuid; }\n}\n` +
      `namespace chat {\n  using \`public\`;\n  model rooms { id: uuid; }\n  op nightly(): void;\n}\n` +
      `namespace cron {\n  @schedule("17 3 * * *")\n  @command("select 1")\n  op nightly(): void;\n}\n` +
      `@@schedule(chat.nightly, "5 4 * * *");\n@@command(chat.nightly, "select 2");\n`,
    );
    expect(emit(main)).rejects.toThrow(/nightly.*one job/s);
  });
});
