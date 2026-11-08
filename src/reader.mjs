// Catalog reader: one Postgres database → IR. Run identically against the
// live db and the shadow db; the differ compares the two IRs. Everything
// printable (expressions, constraint/index/trigger defs) comes from the
// server's own pg_get_* functions, so both sides carry the same
// normalization and string equality is semantic equality.
import { rows } from "./db.mjs";
import { SUPABASE } from "./platform.mjs";
import { catalogKeySql, nameArraySql } from "./schemas.mjs";

// PUBLIC is grantee 0 in an ACL, which prints as "-" until it is named
const GRANTEE = "CASE WHEN a.grantee = 0 THEN 'public' ELSE a.grantee::regrole::text END";

/** One database's catalog as IR. `schemas` are the ones the spec declares; `platform` names the roles that count. */
export function readCatalog(db, { cron = false, schemas = ["public"], platform = SUPABASE } = {}) {
  const ir = {};
  const declared = nameArraySql(schemas);
  const relKey = catalogKeySql("c.relname");
  const roles = nameArraySql(platform.roles);
  const grantees = nameArraySql([...platform.roles, "public"]);
  // Whether an aclexplode row `a` is a grant the check compares. Where
  // migrations run as a named owner, the shadow holds exactly what the spec
  // grants, so every grant but the object owner's is one the spec must
  // declare. Supabase grants to roles of its own as it sees fit, so there only
  // the roles it serves requests as count, and PUBLIC, which reaches each.
  const comparedGrant = (ownerColumn) =>
    platform.owner ? `a.grantee <> ${ownerColumn}` : `${GRANTEE} = ANY(${grantees})`;

  // A schema's privileges are what each of the platform's roles can do there,
  // by any route (a grant to it, to PUBLIC, or to a role it inherits from), and
  // what any other role the check compares was granted, PUBLIC among them. The
  // shadow grants nothing the spec does not, so anything more on the live side
  // is drift. `public` came with the database, and the spec declares nothing
  // about it.
  const schemaRows = rows(db, `
    SELECT n.nspname AS name, n.nspowner::regrole::text AS owner,
           (SELECT json_agg(r.rolname || ':' || p.privilege ORDER BY r.rolname, p.privilege)
              FROM pg_roles r, (VALUES ('CREATE'), ('USAGE')) p(privilege)
             WHERE r.rolname = ANY(${roles})
               AND has_schema_privilege(r.oid, n.oid, p.privilege)) AS privileges,
           (SELECT json_agg(${GRANTEE} || ':' || a.privilege_type ORDER BY ${GRANTEE}, a.privilege_type)
              FROM aclexplode(n.nspacl) a
             WHERE ${comparedGrant("n.nspowner")} AND NOT (${GRANTEE} = ANY(${roles}))) AS other_privileges
    FROM pg_namespace n
    WHERE n.nspname = ANY(${declared}) AND n.nspname <> 'public' ORDER BY 1
  `);
  ir.schemas = Object.fromEntries(schemaRows.map((r) => [r.name, {
    privileges: [...(r.privileges ?? []), ...(r.other_privileges ?? [])],
  }]));

  // Where migrations run as a named owner, no other role may create: neither a
  // schema in the database nor an object in `public`, which holds nothing of
  // the spec's. The shadow lets none, so a role that may on the live side is
  // drift: one of the platform's by any route, or any other granted CREATE.
  if (platform.owner) {
    ir.creators = { database: [], public: [] };
    const creators = rows(db, `
      SELECT 'database' AS place, r.rolname AS role FROM pg_roles r
       WHERE r.rolname = ANY(${roles}) AND has_database_privilege(r.oid, current_database(), 'CREATE')
      UNION
      SELECT 'public', r.rolname FROM pg_roles r JOIN pg_namespace n ON n.nspname = 'public'
       WHERE r.rolname = ANY(${roles}) AND has_schema_privilege(r.oid, n.oid, 'CREATE')
      UNION
      SELECT held.place, ${GRANTEE}
        FROM (SELECT 'database' AS place, datacl AS acl, datdba AS holder FROM pg_database WHERE datname = current_database()
              UNION ALL
              SELECT 'public', nspacl, nspowner FROM pg_namespace WHERE nspname = 'public') held,
             LATERAL aclexplode(held.acl) a
       WHERE a.privilege_type = 'CREATE' AND a.grantee <> held.holder AND a.grantee <> '${platform.owner}'::regrole
      ORDER BY 1, 2
    `);
    for (const { place, role } of creators) ir.creators[place].push(role);
  }

  const enums = rows(db, `
    SELECT ${catalogKeySql("t.typname")} AS name, t.typowner::regrole::text AS owner,
           (SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder)
              FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = ANY(${declared}) AND t.typtype = 'e' ORDER BY 1
  `);
  ir.enums = Object.fromEntries(enums.map((r) => [r.name, r.labels]));

  const tables = rows(db, `
    SELECT ${relKey} AS name, c.relowner::regrole::text AS owner,
           c.relkind = 'p' AS partitioned,
           CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partkey,
           c.relrowsecurity AS rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    -- materialized views and foreign tables too, which no spec declares, so one reads as missing in spec
    WHERE n.nspname = ANY(${declared}) AND c.relkind IN ('r','p','m','f') AND NOT c.relispartition
    ORDER BY 1
  `);

  const cols = rows(db, `
    SELECT ${relKey} AS tab, a.attname AS name,
           format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull AS notnull,
           pg_get_expr(d.adbin, d.adrelid) AS "default",
           a.attgenerated::text <> '' AS generated,
           a.attidentity::text AS identity,
           a.attnum
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = ANY(${declared}) AND c.relkind IN ('r','p','m','f') AND NOT c.relispartition
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY 1, a.attnum
  `);

  const constraints = rows(db, `
    SELECT ${relKey} AS tab, con.conname AS name, con.contype::text AS type,
           pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY(${declared}) AND NOT c.relispartition
    ORDER BY 1, 2
  `);

  const indexes = rows(db, `
    SELECT ${relKey} AS tab, ic.relname AS name, pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY(${declared}) AND NOT c.relispartition
      AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)
    ORDER BY 1, 2
  `);

  const acls = rows(db, `
    SELECT ${relKey} AS tab, ${GRANTEE} AS role, a.privilege_type AS priv
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE n.nspname = ANY(${declared}) AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition
      AND ${comparedGrant("c.relowner")}
    ORDER BY 1, 2, 3
  `);

  const colAcls = rows(db, `
    SELECT ${relKey} AS tab, att.attname AS col, ${GRANTEE} AS role,
           a.privilege_type AS priv
    FROM pg_attribute att
    JOIN pg_class c ON c.oid = att.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace,
         LATERAL aclexplode(att.attacl) a
    WHERE n.nspname = ANY(${declared}) AND att.attacl IS NOT NULL AND NOT c.relispartition
      AND ${comparedGrant("c.relowner")}
    ORDER BY 1, 2, 3, 4
  `);

  const grantsOn = (rel) => [
    ...acls.filter((a) => a.tab === rel).map((a) => `${a.role}:${a.priv}`),
    ...colAcls.filter((a) => a.tab === rel).map((a) => `${a.role}:${a.priv}(${a.col})`),
  ].sort();

  ir.tables = {};
  for (const t of tables) {
    ir.tables[t.name] = {
      partitioned: t.partitioned, partkey: t.partkey, rls: t.rls,
      columns: cols.filter((c) => c.tab === t.name).map(({ tab, attnum, ...c }) => c),
      constraints: Object.fromEntries(
        constraints.filter((c) => c.tab === t.name).map((c) => [c.name, { type: c.type, def: c.def }]),
      ),
      // " ON ONLY " normalized away: a partitioned parent's index prints ONLY
      // depending on child-attachment state, which is not a spec-relevant fact.
      indexes: Object.fromEntries(
        indexes.filter((i) => i.tab === t.name).map((i) => [i.name, i.def.replace(" ON ONLY ", " ON ")]),
      ),
      grants: grantsOn(t.name),
    };
  }

  const policies = rows(db, `
    SELECT schemaname || '.' || tablename AS tab, policyname AS name,
           permissive, cmd, roles::text[] AS roles, qual, with_check
    FROM pg_policies
    WHERE (schemaname = ANY(${declared}) OR schemaname || '.' || tablename = ANY(${nameArraySql(platform.policyTables)}))
      -- partition children are unmanaged (created at runtime); so are their policies
      AND NOT EXISTS (
        SELECT 1 FROM pg_class pc JOIN pg_namespace pn ON pn.oid = pc.relnamespace
        WHERE pn.nspname = schemaname AND pc.relname = tablename AND pc.relispartition)
    ORDER BY 1, 2
  `);
  ir.policies = Object.fromEntries(
    policies.map((p) => [
      `${p.tab}:${p.name}`,
      { permissive: p.permissive, cmd: p.cmd, roles: [...p.roles].sort(), qual: p.qual, with_check: p.with_check },
    ]),
  );

  const triggers = rows(db, `
    SELECT ${relKey} AS tab, t.tgname AS name, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY(${declared}) AND NOT t.tgisinternal AND NOT c.relispartition
    ORDER BY 1, 2
  `);
  ir.triggers = Object.fromEntries(triggers.map((t) => [`${t.tab}:${t.name}`, t.def]));

  const funcs = rows(db, `
    SELECT ${catalogKeySql("p.proname")} AS name,
           pg_get_function_identity_arguments(p.oid) AS identity_args,
           pg_get_function_arguments(p.oid) AS args,
           pg_get_function_result(p.oid) AS returns,
           l.lanname AS language,
           p.provolatile::text AS volatility,
           p.proisstrict AS strict,
           p.prosecdef AS security_definer,
           p.proconfig AS config,
           btrim(p.prosrc, E' \\n\\t') AS body,
           p.proacl IS NULL OR EXISTS (
             SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
           ) AS public_execute,
           -- PUBLIC's EXECUTE is public_execute
           (SELECT json_agg(a.grantee::regrole::text ORDER BY a.grantee::regrole::text)
              FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> 0
               AND ${comparedGrant("p.proowner")}) AS grants,
           p.proowner::regrole::text AS owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    -- every routine: a procedure or an aggregate, which no spec declares, reads as missing in spec
    WHERE n.nspname = ANY(${declared})
      -- extension-owned functions are the extension's business, not the spec's
      AND NOT EXISTS (SELECT 1 FROM pg_depend dep
                      WHERE dep.objid = p.oid AND dep.deptype = 'e')
    ORDER BY 1, 2
  `);
  const functionKey = (f) => `${f.name}(${f.identity_args})`;
  ir.functions = Object.fromEntries(
    funcs.map((f) => [
      functionKey(f),
      { args: f.args, returns: f.returns, language: f.language, volatility: f.volatility,
        strict: f.strict, security_definer: f.security_definer, config: f.config ?? null,
        body: f.body, public_execute: f.public_execute, grants: f.grants ?? [] },
    ]),
  );

  const views = rows(db, `
    SELECT ${relKey} AS name, c.relowner::regrole::text AS owner, pg_get_viewdef(c.oid) AS def,
           coalesce(c.reloptions::text LIKE '%security_invoker=%true%'
                 OR c.reloptions::text LIKE '%security_invoker=on%', false) AS security_invoker,
           (SELECT json_agg(json_build_array(a.attname, format_type(a.atttypid, a.atttypmod))
                   ORDER BY a.attnum)
              FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY(${declared}) AND c.relkind = 'v'
    ORDER BY 1
  `);
  ir.views = Object.fromEntries(
    views.map((v) => [v.name, {
      def: v.def, security_invoker: v.security_invoker, columns: v.columns,
      grants: grantsOn(v.name),
    }]),
  );

  // Who owns each object, where the platform names the role migrations run as:
  // that role must own what they make, or it cannot alter it, and a security
  // definer function runs with another role's rights.
  if (platform.owner) {
    const owners = (list, key = (r) => r.name) => Object.fromEntries(list.map((r) => [key(r), r.owner]));
    ir.owners = {
      schema: owners(schemaRows),
      enum: owners(enums),
      table: owners(tables),
      function: owners(funcs, functionKey),
      view: owners(views),
    };
  }

  if (cron) {
    // pg_cron keeps its job list in one database of the cluster, and any other
    // has none to read: null, which the check refuses when the spec schedules a job
    const [{ installed }] = rows(db, "SELECT to_regclass('cron.job') IS NOT NULL AS installed");
    ir.cron = installed ? Object.fromEntries(rows(db, `
      SELECT jobname AS name, schedule, btrim(command, E' \\n\\t') AS command
      FROM cron.job ORDER BY 1
    `).map((c) => [c.name, { schedule: c.schedule, command: c.command }])) : null;
  }

  return ir;
}
