import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { emit } from "../src/emitter.mjs";
import { prelude } from "../src/prelude.mjs";
import { readCatalog } from "../src/reader.mjs";
import { diff } from "../src/differ.mjs";
import { sql, script } from "../src/db.mjs";
import { clusterHasPostgrestRoles, specDir } from "./harness.mjs";

// What pgspec-check does, on databases named for this run: the spec's DDL
// builds a shadow, a migration builds the database the spec describes, and
// the two catalogs are compared. The cluster may be shared with another
// checkout or a running check, so nothing here takes the check's own names.
const RUN = `pgspec_roundtrip_${process.pid}_${Date.now()}`;
const SHADOW = `${RUN}_shadow`;
const LIVE = `${RUN}_live`;
const DRIFTED = `${RUN}_drifted`;

const BODIES = {
  keep_owner: "begin return null; end",
  room_count: "select count(*) from chat.rooms",
  new_token: "select 'token'::text, 'hash'::bytea",
};

const SPEC = `namespace chat {
  using \`public\`;

  @pk("id")
  model rooms {
    id: uuid;
    owner_id?: uuid;
  }

  @function("plpgsql")
  op keep_owner(): trigger;

  @function("sql stable")
  op room_count(): bigint;

  @function("sql")
  op new_token(@out token: text, @out hash: bytea): \`record\`;

  // ── security ──────────────────────────────────────────

  @@grant(chat, "authenticated", "usage");

  @@grant(room_count, "authenticated", "execute");

  // ── impl ──────────────────────────────────────────────

  @@trigger(rooms, "rooms_keep_owner", "AFTER INSERT OR UPDATE DEFERRABLE INITIALLY DEFERRED FOR EACH ROW", keep_owner);
}
`;

// The same objects as a migration writes them. new_token has no RETURNS
// clause and is revoked by its input arguments alone, both of which Postgres
// allows: the catalogs agree whichever way the SQL was spelled.
const MIGRATION = `
CREATE SCHEMA chat;
CREATE TABLE chat.rooms (id uuid PRIMARY KEY, owner_id uuid);
CREATE FUNCTION chat.keep_owner() RETURNS trigger LANGUAGE plpgsql AS $$${BODIES.keep_owner}$$;
CREATE FUNCTION chat.room_count() RETURNS bigint LANGUAGE sql STABLE AS $$${BODIES.room_count}$$;
CREATE FUNCTION chat.new_token(OUT token text, OUT hash bytea) LANGUAGE sql AS $$${BODIES.new_token}$$;
REVOKE ALL ON FUNCTION chat.keep_owner(), chat.room_count(), chat.new_token() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER rooms_keep_owner AFTER INSERT OR UPDATE ON chat.rooms
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION chat.keep_owner();
GRANT USAGE ON SCHEMA chat TO authenticated;
GRANT EXECUTE ON FUNCTION chat.room_count() TO authenticated;
`;

// The migration, then one change each to the trigger's deferral, the
// schema's USAGE and new_token's parameter modes.
const DRIFT = `
DROP TRIGGER rooms_keep_owner ON chat.rooms;
CREATE CONSTRAINT TRIGGER rooms_keep_owner AFTER INSERT OR UPDATE ON chat.rooms
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION chat.keep_owner();
REVOKE USAGE ON SCHEMA chat FROM authenticated;
DROP FUNCTION chat.new_token();
CREATE FUNCTION chat.new_token(token text, hash bytea) RETURNS record LANGUAGE sql AS $$${BODIES.new_token}$$;
REVOKE ALL ON FUNCTION chat.new_token(text, bytea) FROM PUBLIC;
`;

describe.skipIf(!clusterHasPostgrestRoles())("a spec checked against the database it describes", () => {
  let spec;
  let live;
  let drifted;

  beforeAll(async () => {
    const files = Object.fromEntries(Object.entries(BODIES).map(([name, body]) => [`fn/${name}.sql`, `${body}\n`]));
    const { ddl, schemas } = await emit(specDir(SPEC, files));
    for (const db of [SHADOW, LIVE, DRIFTED]) sql("postgres", `CREATE DATABASE ${db}`);
    script(SHADOW, prelude(SHADOW));
    script(SHADOW, ddl);
    script(LIVE, MIGRATION);
    script(DRIFTED, MIGRATION + DRIFT);
    [spec, live, drifted] = [SHADOW, LIVE, DRIFTED].map((db) => readCatalog(db, { schemas }));
  });

  afterAll(() => {
    for (const db of [SHADOW, LIVE, DRIFTED]) sql("postgres", `DROP DATABASE IF EXISTS ${db}`);
  });

  test("a_constraint_trigger_reads_back_with_its_deferral_after_the_table", () => {
    expect(live.triggers["chat.rooms:rooms_keep_owner"]).toBe(
      "CREATE CONSTRAINT TRIGGER rooms_keep_owner AFTER INSERT OR UPDATE ON chat.rooms " +
      "DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION chat.keep_owner()",
    );
    // Postgres records it as a constraint too, whose definition is its deferral.
    expect(live.tables["chat.rooms"].constraints.rooms_keep_owner).toEqual({
      type: "t", def: "TRIGGER DEFERRABLE INITIALLY DEFERRED",
    });
  });

  test("an_opened_schema_reads_back_with_its_usage_and_function_grant", () => {
    expect(live.schemas.chat).toEqual({ privileges: ["authenticated:USAGE"] });
    expect(live.functions["chat.room_count()"].grants).toEqual(["authenticated"]);
  });

  test("out_parameters_read_back_with_their_mode", () => {
    expect(live.functions["chat.new_token(OUT token text, OUT hash bytea)"]).toMatchObject({
      args: "OUT token text, OUT hash bytea", returns: "record",
    });
  });

  test("the_spec_matches_the_database_it_describes", () => {
    expect(diff(spec, live)).toEqual([]);
  });

  test("each_change_to_that_database_is_drift", () => {
    expect(diff(spec, drifted).map((p) => `${p.layer} ${p.kind} ${p.key}: ${p.what}`)).toEqual([
      "contract schema chat: privileges differs",
      "contract constraint chat.rooms rooms_keep_owner: definition differs",
      "impl trigger chat.rooms:rooms_keep_owner: definition differs",
      "contract function chat.new_token(OUT token text, OUT hash bytea): missing in database (spec expects it)",
      "contract function chat.new_token(token text, hash bytea): missing in spec (exists in database)",
    ]);
  });
});
