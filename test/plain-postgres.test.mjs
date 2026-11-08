import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { emit } from "../src/emitter.mjs";
import { plainPostgres } from "../src/platform.mjs";
import { readCatalog } from "../src/reader.mjs";
import { diff } from "../src/differ.mjs";
import { rows, sql, script } from "../src/db.mjs";
import { canCreateRoles, runCheck, specDir } from "./harness.mjs";

// What pgspec-check does on plain Postgres, where migrations run as an owner
// role and the application signs in as a runtime role. The cluster may be
// shared with another checkout or a running check, so the roles and databases
// are this run's own.
const RUN = `pgspec_plain_${process.pid}_${Date.now()}`;
const OWNER = `${RUN}_owner`;
const RUNTIME = `${RUN}_runtime`;
// a role the spec grants nothing, which the live database may still let in
const INTERN = `${RUN}_intern`;
const PLATFORM = plainPostgres({ owner: OWNER, roles: [RUNTIME] });
const database = (name) => `${RUN}_${name}`;
const SHADOW = database("shadow");
const LIVE = database("live");
const DRIFTED = database("drifted");
const ELSEWHERE = database("elsewhere");
const HARDENED = database("hardened");
const WITHOUT_PUBLIC = database("without_public");
const RUNTIME_OWNED = database("runtime_owned");
const DATABASES = [SHADOW, LIVE, DRIFTED, ELSEWHERE, HARDENED, WITHOUT_PUBLIC, RUNTIME_OWNED];

const ROOM_COUNT = "select count(*) from chat.rooms";

const SPEC = `namespace chat {
  using \`public\`;

  enum mood {
    calm,
    busy,
  }

  @pk("id")
  model rooms {
    id: uuid;
    label?: text;
  }

  @function("sql stable security definer")
  op room_count(): bigint;

  // ── security ──────────────────────────────────────────

  @@grant(chat, "${RUNTIME}", "usage");

  @@grant(rooms, "${RUNTIME}", "select, insert, update, delete");

  @@grant(room_count, "${RUNTIME}", "execute");
}
`;
const BODIES = { "fn/room_count.sql": `${ROOM_COUNT}\n` };

// The same objects as a migration writes them: as the owner, with the runtime
// role's privileges set as default privileges rather than granted one by one.
// A default privilege writes the same entry naming the role that a GRANT does,
// and that entry is what the check reads on a table or function.
const migration = (name) => `
GRANT CREATE ON DATABASE ${name} TO ${OWNER};
SET ROLE ${OWNER};
ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS TO ${RUNTIME};
ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME};
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${RUNTIME};
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE SCHEMA chat;
CREATE TYPE chat.mood AS ENUM ('calm', 'busy');
CREATE TABLE chat.rooms (id uuid PRIMARY KEY, label text);
CREATE FUNCTION chat.room_count() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS $$${ROOM_COUNT}$$;
RESET ROLE;
`;

// The migration, then changes that leave every privilege of the runtime role
// on the spec's objects as it was: other owners, each granted what the owner
// had, grants to PUBLIC, and room for the runtime role to create.
const drift = (name) => `
ALTER TYPE chat.mood OWNER TO SESSION_USER;
ALTER TABLE chat.rooms OWNER TO SESSION_USER;
GRANT ALL ON chat.rooms TO ${OWNER};
ALTER FUNCTION chat.room_count() OWNER TO SESSION_USER;
GRANT EXECUTE ON FUNCTION chat.room_count() TO ${OWNER};
GRANT SELECT ON chat.rooms TO PUBLIC;
GRANT USAGE ON SCHEMA chat TO PUBLIC;
GRANT CREATE ON DATABASE ${name} TO ${RUNTIME};
GRANT CREATE ON SCHEMA public TO ${RUNTIME};
`;

// The migration, then the database, the schema, the table and the function
// opened to a role the spec never names.
const anotherRole = (name) => `
GRANT CREATE ON DATABASE ${name} TO ${INTERN};
GRANT USAGE ON SCHEMA chat TO ${INTERN};
GRANT ALL ON chat.rooms TO ${INTERN};
GRANT EXECUTE ON FUNCTION chat.room_count() TO ${INTERN};
`;

describe.skipIf(!canCreateRoles())("a spec checked against plain Postgres", () => {
  let spec;
  let read;

  beforeAll(async () => {
    for (const role of [OWNER, RUNTIME, INTERN]) sql("postgres", `CREATE ROLE ${role} NOLOGIN`);
    // The login builds the shadow as the owner, as pgspec-check's does, and
    // creates a database the runtime role owns. It is named rather than
    // CURRENT_USER, on which Supabase's Postgres crashes.
    const [{ login }] = rows("postgres", "SELECT current_user AS login");
    sql("postgres", `GRANT ${OWNER}, ${RUNTIME} TO ${login}`);

    const { ddl, cron, schemas } = await emit(specDir(SPEC, BODIES), { platform: PLATFORM });
    for (const name of DATABASES) {
      sql("postgres", `CREATE DATABASE ${name}${name === RUNTIME_OWNED ? ` OWNER ${RUNTIME}` : ""}`);
    }
    script(SHADOW, PLATFORM.prelude(SHADOW) + ddl);
    script(LIVE, migration(LIVE));
    script(DRIFTED, migration(DRIFTED) + drift(DRIFTED));
    script(ELSEWHERE, migration(ELSEWHERE) + anotherRole(ELSEWHERE));
    // `public` closed further and handed to the owner, or gone: nothing the spec declares
    script(HARDENED, `${migration(HARDENED)}REVOKE ALL ON SCHEMA public FROM PUBLIC;\nALTER SCHEMA public OWNER TO ${OWNER};\n`);
    script(WITHOUT_PUBLIC, `${migration(WITHOUT_PUBLIC)}DROP SCHEMA public;\n`);
    script(RUNTIME_OWNED, migration(RUNTIME_OWNED));
    // as the check reads them: jobs from the live side, and from the spec on the shadow's
    spec = { ...readCatalog(SHADOW, { schemas, platform: PLATFORM }), cron };
    read = (name) => readCatalog(name, { cron: true, schemas, platform: PLATFORM });
  });

  afterAll(() => {
    for (const name of DATABASES) sql("postgres", `DROP DATABASE IF EXISTS ${name}`);
    for (const role of [INTERN, RUNTIME, OWNER]) sql("postgres", `DROP ROLE IF EXISTS ${role}`);
  });

  const driftOf = (name) => diff(spec, read(name)).map((p) => `${p.layer} ${p.kind} ${p.key}: ${p.what}`);

  test("the_shadow_has_none_of_supabases_schemas", () => {
    const found = rows(SHADOW, "SELECT nspname FROM pg_namespace WHERE nspname IN ('extensions', 'auth', 'storage', 'realtime')");
    expect(found).toEqual([]);
  });

  test("the_owner_owns_what_the_shadow_makes", () => {
    expect(spec.owners).toEqual({
      schema: { chat: OWNER },
      enum: { "chat.mood": OWNER },
      table: { "chat.rooms": OWNER },
      function: { "chat.room_count()": OWNER },
      view: {},
    });
  });

  test("the_runtime_role_reads_back_with_its_privileges", () => {
    const live = read(LIVE);
    expect(live.schemas.chat).toEqual({ privileges: [`${RUNTIME}:USAGE`] });
    expect(live.tables["chat.rooms"].grants).toEqual([
      `${RUNTIME}:DELETE`, `${RUNTIME}:INSERT`, `${RUNTIME}:SELECT`, `${RUNTIME}:UPDATE`,
    ]);
    expect(live.functions["chat.room_count()"]).toMatchObject({ grants: [RUNTIME], public_execute: false });
  });

  test("no_role_but_the_owner_may_create", () => {
    expect(read(LIVE).creators).toEqual({ database: [], public: [] });
    expect(read(DRIFTED).creators).toEqual({ database: [RUNTIME], public: [RUNTIME] });
  });

  test("a_database_without_pg_cron_has_no_job_list_to_read", () => {
    expect(read(LIVE).cron).toBeNull();
  });

  test("the_spec_matches_the_database_it_describes", () => {
    expect(driftOf(LIVE)).toEqual([]);
  });

  test("each_change_to_that_database_is_drift", () => {
    expect(driftOf(DRIFTED)).toEqual([
      "contract create in database: roles differs",
      "contract create in public: roles differs",
      "contract schema chat: privileges differs",
      "contract table chat.rooms: grants differs",
      "contract function chat.room_count(): grants differs",
      "contract enum chat.mood: owner differs",
      "contract table chat.rooms: owner differs",
      "contract function chat.room_count(): owner differs",
    ]);
  });

  test("a_grant_to_a_role_the_spec_never_names_is_drift", () => {
    expect(driftOf(ELSEWHERE)).toEqual([
      "contract create in database: roles differs",
      "contract schema chat: privileges differs",
      "contract table chat.rooms: grants differs",
      "contract function chat.room_count(): grants differs",
    ]);
  });

  test("closing_public_further_handing_it_to_the_owner_or_dropping_it_is_no_drift", () => {
    expect(driftOf(HARDENED)).toEqual([]);
    expect(driftOf(WITHOUT_PUBLIC)).toEqual([]);
  });

  // The database's owner may create in it and in `public`, so a runtime role
  // that owns the database could.
  test("a_database_the_runtime_role_owns_is_drift", () => {
    expect(driftOf(RUNTIME_OWNED)).toEqual([
      "contract create in database: roles differs",
      "contract create in public: roles differs",
    ]);
  });

  // These stop before the shadow is built: pgspec-check builds it under one
  // name per cluster, which a test must not take from a check running beside it.
  describe("pgspec-check stops with exit 3", () => {
    const stops = ({ status, stderr }, named) => {
      expect(status).toBe(3);
      expect(stderr).toContain("pgspec-check: ");
      expect(stderr).toContain(named);
    };

    test("on_a_grant_to_a_role_the_platform_does_not_name", () => {
      const typo = `${RUN}_runtme`;
      const args = [specDir(SPEC, BODIES), "--platform=postgres", `--owner=${OWNER}`, `--roles=${typo}`];
      stops(runCheck(args, { SPEC_DB_NAME: LIVE }), typo);
    });

    test("on_a_job_the_database_has_no_list_for", () => {
      const withJob = `${SPEC}namespace cron {\n  @schedule("17 3 * * *")\n  @command("select 1")\n  op nightly(): void;\n}\n`;
      const args = [specDir(withJob, BODIES), "--platform=postgres", `--owner=${OWNER}`, `--roles=${RUNTIME}`];
      stops(runCheck(args, { SPEC_DB_NAME: LIVE }), "nightly");
    });
  });
});
