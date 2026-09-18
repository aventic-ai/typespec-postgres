import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readCatalog } from "../src/reader.mjs";
import { rows, sql, script } from "../src/db.mjs";

// Reads a real catalog, so it runs only when the SPEC_DB_* cluster answers and
// carries the PostgREST roles the fixture grants to, as pgspec-check requires.
function clusterHasPostgrestRoles() {
  if (!process.env.SPEC_DB_PASSWORD) return false;
  try {
    const found = rows("postgres", "SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')");
    return found.length === 3;
  } catch {
    return false;
  }
}

// Unique per run: the cluster may be shared with another checkout or CI job.
const DB = `pgspec_reader_test_${process.pid}_${Date.now()}`;

// Sessions in this database search `chat` first, the way a live one may. The
// setting is per role and database because that outranks a role's own
// search_path, which a Supabase cluster sets; it goes when the database does.
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

CREATE SCHEMA lobby;
GRANT USAGE ON SCHEMA lobby TO PUBLIC;

CREATE SCHEMA vault_like;

ALTER ROLE CURRENT_USER IN DATABASE ${DB} SET search_path = chat, public;
`;

describe.skipIf(!clusterHasPostgrestRoles())("reading a catalog with more than one schema", () => {
  let declared;
  let publicOnly;

  beforeAll(() => {
    sql("postgres", `CREATE DATABASE ${DB}`);
    script(DB, FIXTURE);
    declared = readCatalog(DB, { schemas: ["public", "chat", "lobby", "vault_like"] });
    publicOnly = readCatalog(DB);
  });

  afterAll(() => sql("postgres", `DROP DATABASE IF EXISTS ${DB}`));

  test("public_keys_stay_bare_and_other_schemas_are_qualified", () => {
    expect(Object.keys(declared.tables).sort()).toEqual(["chat.orgs", "chat.rooms", "orgs"]);
    expect(Object.keys(declared.enums)).toEqual(["chat.mood"]);
    expect(Object.keys(declared.views)).toEqual(["chat.open_rooms"]);
    expect(Object.keys(declared.functions).sort()).toEqual(["chat.room_count()", "touch_updated_at()"]);
    expect(Object.keys(declared.triggers)).toEqual(["chat.rooms:rooms_touch"]);
    expect(Object.keys(declared.policies)).toEqual(["chat.rooms:members read"]);
  });

  test("same_named_tables_in_two_schemas_keep_their_own_columns", () => {
    expect(declared.tables.orgs.columns.map((c) => c.name)).toEqual(["id"]);
    expect(declared.tables["chat.orgs"].columns.map((c) => c.name)).toEqual(["id", "label"]);
  });

  test("a_table_outside_public_carries_every_fact", () => {
    const rooms = declared.tables["chat.rooms"];
    expect(rooms.rls).toBe(true);
    expect(rooms.grants).toEqual(["service_role:SELECT"]);
    expect(rooms.constraints.rooms_org_id_fkey.def).toBe("FOREIGN KEY (org_id) REFERENCES orgs(id)");
  });

  test("names_print_the_same_whatever_the_database_searches_first", () => {
    const rooms = declared.tables["chat.rooms"];
    expect(rooms.columns.find((c) => c.name === "feeling").type).toBe("chat.mood");
    expect(rooms.indexes.rooms_org_idx).toContain(" ON chat.rooms ");
    expect(declared.views["chat.open_rooms"].def).toContain("FROM chat.rooms");
  });

  test("a_schema_reports_the_postgrest_roles_a_direct_grant_lets_in", () => {
    expect(declared.schemas.chat).toEqual({ privileges: ["authenticated:USAGE"] });
  });

  test("usage_granted_to_public_lets_every_postgrest_role_in", () => {
    expect(declared.schemas.lobby).toEqual({
      privileges: ["anon:USAGE", "authenticated:USAGE", "service_role:USAGE"],
    });
  });

  test("a_schema_nobody_was_granted_is_closed", () => {
    expect(declared.schemas.vault_like).toEqual({ privileges: [] });
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
