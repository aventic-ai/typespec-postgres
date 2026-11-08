import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readCatalog } from "../src/reader.mjs";
import { sql, script } from "../src/db.mjs";
import { SUPABASE } from "../src/platform.mjs";
import { clusterAnswers, clusterHasRoles } from "./harness.mjs";

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
CREATE MATERIALIZED VIEW chat.room_copy AS SELECT id FROM chat.rooms;
CREATE PROCEDURE chat.tidy() LANGUAGE sql AS $$ select 1 $$;
GRANT SELECT (id) ON chat.open_rooms TO PUBLIC;
GRANT SELECT ON chat.rooms TO service_role;
GRANT SELECT ON chat.orgs TO PUBLIC;
GRANT UPDATE (label) ON chat.orgs TO PUBLIC;
GRANT USAGE ON SCHEMA chat TO authenticated;

CREATE SCHEMA lobby;
GRANT USAGE ON SCHEMA lobby TO PUBLIC;

CREATE SCHEMA vault_like;

ALTER ROLE CURRENT_USER IN DATABASE ${DB} SET search_path = chat, public;
`;

describe.skipIf(!clusterHasRoles(SUPABASE.roles))("reading a catalog with more than one schema", () => {
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
    expect(Object.keys(declared.tables).sort()).toEqual(["chat.orgs", "chat.room_copy", "chat.rooms", "orgs"]);
    expect(Object.keys(declared.enums)).toEqual(["chat.mood"]);
    expect(Object.keys(declared.views)).toEqual(["chat.open_rooms"]);
    expect(Object.keys(declared.functions).sort()).toEqual(["chat.room_count()", "chat.tidy()", "touch_updated_at()"]);
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

  // PUBLIC reaches every role, so a grant to it is one the check must see.
  test("a_grant_to_public_reads_back_as_public", () => {
    expect(declared.tables["chat.orgs"].grants).toEqual(["public:SELECT", "public:UPDATE(label)"]);
    expect(declared.views["chat.open_rooms"].grants).toEqual(["public:SELECT(id)"]);
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

  test("usage_granted_to_public_lets_every_postgrest_role_in_and_reads_as_public", () => {
    expect(declared.schemas.lobby).toEqual({
      privileges: ["anon:USAGE", "authenticated:USAGE", "service_role:USAGE", "public:USAGE"],
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

// pg_cron keeps its job list in cron.job, in one database of the cluster. A
// table of the same shape stands in for it, so this runs on any cluster.
describe.skipIf(!clusterAnswers())("reading pg_cron's job list", () => {
  const WITH_JOBS = `${DB}_jobs`;
  const WITHOUT = `${DB}_no_jobs`;

  beforeAll(() => {
    for (const db of [WITH_JOBS, WITHOUT]) sql("postgres", `CREATE DATABASE ${db}`);
    script(WITH_JOBS, `
      CREATE SCHEMA cron;
      CREATE TABLE cron.job (jobname text, schedule text, command text);
      INSERT INTO cron.job VALUES ('nightly', '17 3 * * *', E'\\n  select 1\\n');
    `);
  });

  afterAll(() => {
    for (const db of [WITH_JOBS, WITHOUT]) sql("postgres", `DROP DATABASE IF EXISTS ${db}`);
  });

  test("each_job_reads_back_with_its_schedule_and_trimmed_command", () => {
    expect(readCatalog(WITH_JOBS, { cron: true }).cron).toEqual({ nightly: { schedule: "17 3 * * *", command: "select 1" } });
  });

  test("a_database_without_the_list_has_none_to_read", () => {
    expect(readCatalog(WITHOUT, { cron: true }).cron).toBeNull();
  });

  test("the_list_is_read_only_when_asked_for", () => {
    expect(readCatalog(WITH_JOBS).cron).toBeUndefined();
  });
});
