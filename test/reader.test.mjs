import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readCatalog } from "../src/reader.mjs";
import { sql, script } from "../src/db.mjs";

// Reads a real catalog: runs only against the cluster the SPEC_DB_* variables
// name, which must carry the PostgREST roles, as pgspec-check itself requires.
const reachable = Boolean(process.env.SPEC_DB_PASSWORD);
const DB = "pgspec_reader_test";

const FIXTURE = `
CREATE TABLE public.orgs (id uuid PRIMARY KEY);
CREATE FUNCTION public.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ begin return new; end $$;

CREATE SCHEMA chat;
CREATE TYPE chat.mood AS ENUM ('calm', 'busy');
CREATE TABLE chat.orgs (id uuid PRIMARY KEY, label text);
CREATE TABLE chat.rooms (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  feeling chat.mood NOT NULL DEFAULT 'calm'
);
CREATE INDEX rooms_org_idx ON chat.rooms (org_id);
ALTER TABLE chat.rooms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read" ON chat.rooms FOR SELECT TO authenticated USING (true);
CREATE TRIGGER rooms_touch BEFORE UPDATE ON chat.rooms
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE FUNCTION chat.room_count() RETURNS bigint LANGUAGE sql STABLE AS $$ select count(*) from chat.rooms $$;
CREATE VIEW chat.open_rooms AS SELECT id FROM chat.rooms;
GRANT SELECT ON chat.rooms TO service_role;
GRANT USAGE ON SCHEMA chat TO authenticated;
`;

describe.skipIf(!reachable)("reading a catalog with a second schema", () => {
  let both;
  let publicOnly;

  beforeAll(() => {
    sql("postgres", `DROP DATABASE IF EXISTS ${DB}`);
    sql("postgres", `CREATE DATABASE ${DB}`);
    script(DB, FIXTURE);
    both = readCatalog(DB, { schemas: ["public", "chat"] });
    publicOnly = readCatalog(DB);
  });

  afterAll(() => sql("postgres", `DROP DATABASE IF EXISTS ${DB}`));

  test("public_keys_stay_bare_and_other_schemas_are_qualified", () => {
    expect(Object.keys(both.tables).sort()).toEqual(["chat.orgs", "chat.rooms", "orgs"]);
    expect(Object.keys(both.enums)).toEqual(["chat.mood"]);
    expect(Object.keys(both.views)).toEqual(["chat.open_rooms"]);
    expect(Object.keys(both.functions).sort()).toEqual(["chat.room_count()", "touch_updated_at()"]);
    expect(Object.keys(both.triggers)).toEqual(["chat.rooms:rooms_touch"]);
    expect(Object.keys(both.policies)).toEqual(["chat.rooms:members read"]);
  });

  test("same_named_tables_in_two_schemas_keep_their_own_columns", () => {
    expect(both.tables.orgs.columns.map((c) => c.name)).toEqual(["id"]);
    expect(both.tables["chat.orgs"].columns.map((c) => c.name)).toEqual(["id", "label"]);
  });

  test("a_table_outside_public_carries_every_fact", () => {
    const rooms = both.tables["chat.rooms"];
    expect(rooms.rls).toBe(true);
    expect(rooms.grants).toEqual(["service_role:SELECT"]);
    expect(rooms.columns.find((c) => c.name === "feeling").type).toBe("chat.mood");
    expect(rooms.constraints.rooms_org_id_fkey.def).toBe("FOREIGN KEY (org_id) REFERENCES orgs(id)");
    expect(rooms.indexes.rooms_org_idx).toContain(" ON chat.rooms ");
  });

  test("a_declared_schema_reports_which_postgrest_roles_may_use_it", () => {
    expect(both.schemas).toEqual({ chat: { grants: ["authenticated:USAGE"] } });
  });

  test("a_declared_schema_the_database_lacks_is_absent", () => {
    expect(readCatalog(DB, { schemas: ["public", "nowhere"] }).schemas).toEqual({});
  });

  test("without_a_schema_list_only_public_is_read", () => {
    expect(Object.keys(publicOnly.tables)).toEqual(["orgs"]);
    expect(Object.keys(publicOnly.functions)).toEqual(["touch_updated_at()"]);
    expect(publicOnly.enums).toEqual({});
    expect(publicOnly.policies).toEqual({});
    expect(publicOnly.schemas).toEqual({});
  });
});
