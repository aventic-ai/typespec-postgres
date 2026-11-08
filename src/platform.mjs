// The platform a spec's database runs on, a setting of the emit and the
// check: the roles whose privileges the check compares, the role migrations
// run as, and what the platform itself owns. Supabase is the default.
import { supabasePrelude } from "./prelude.mjs";
import { assertPlain } from "./schemas.mjs";

/** Supabase, whose PostgREST serves requests as anon, authenticated and service_role. */
export const SUPABASE = {
  // the roles a grant can reach; a grant to PUBLIC reaches each of them
  roles: ["anon", "authenticated", "service_role"],
  // the role migrations run as, which owns what they make; null is the
  // signed-in user, who builds the shadow as well, so no owner is compared
  owner: null,
  // PostgREST serves the spec's data from `public`, whose privileges are the
  // platform's. A table or view beside it opens to no role: PostgREST reaches
  // data there only through a function the spec opens.
  dataInPublic: true,
  // the schemas the platform owns, which no spec may own an object in. The
  // prelude creates them by hand; a test holds this list to its statements.
  schemas: ["extensions", "auth", "storage", "realtime"],
  // the platform's tables, as schema.name, whose policies the spec owns
  policyTables: ["storage.objects", "realtime.messages"],
  // what the shadow runs before the spec's DDL
  prelude: supabasePrelude,
};

/** Plain Postgres, which owns nothing a spec references: migrations run as `owner`, and grants reach `roles`. */
export function plainPostgres({ owner, roles }) {
  if (!owner) throw new Error("plain Postgres needs an owner: the role its migrations run as");
  if (!roles?.length) throw new Error("plain Postgres needs the roles a grant can reach");
  assertPlain("role name", [owner, ...roles]);
  if (roles.includes(owner)) throw new Error(`${owner} is the owner: it holds every privilege on what it owns, and no grant reaches it`);
  return {
    roles,
    owner,
    // Postgres 15 and later close `public` to every role but the database's
    // owner, so the spec's data lives beside it, where a schema the spec opens
    // to a role opens its tables and views too. The check holds the database to
    // that: no role but the owner may create in it or in `public`.
    dataInPublic: false,
    schemas: [],
    policyTables: [],
    // the one thing a database grants the role its migrations run as; the DDL
    // then runs as that role, so what the shadow makes is the owner's
    prelude: (db) => `GRANT CREATE ON DATABASE ${db} TO ${owner};\nSET ROLE ${owner};\n`,
  };
}

/** The platform `pgspec-check --platform` names; `roles` is the comma-separated `--roles`. */
export function platformNamed(name, { owner, roles } = {}) {
  if (name === "postgres") return plainPostgres({ owner, roles: roles?.split(",") });
  if (name !== "supabase") throw new Error(`no platform ${name}: supabase or postgres`);
  if (owner || roles) throw new Error("Supabase's roles are its own: --owner and --roles name plain Postgres's");
  return SUPABASE;
}
