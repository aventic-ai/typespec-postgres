// Catalog reader: one Postgres database → IR. Run identically against the
// live db and the shadow db; the differ compares the two IRs. Everything
// printable (expressions, constraint/index/trigger defs) comes from the
// server's own pg_get_* functions, so both sides carry the same
// normalization and string equality is semantic equality.
import { rows } from "./db.mjs";

const MANAGED_ROLES = ["anon", "authenticated", "service_role"];
const EXTERNAL_POLICY_TABLES = ["storage.objects", "realtime.messages"];

export function readCatalog(db, { cron = false } = {}) {
  const ir = {};

  ir.enums = Object.fromEntries(
    rows(db, `
      SELECT t.typname AS name,
             (SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder)
                FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype = 'e' ORDER BY 1
    `).map((r) => [r.name, r.labels]),
  );

  const tables = rows(db, `
    SELECT c.relname AS name,
           c.relkind = 'p' AS partitioned,
           CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partkey,
           c.relrowsecurity AS rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
    ORDER BY 1
  `);

  const cols = rows(db, `
    SELECT c.relname AS tab, a.attname AS name,
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
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum
  `);

  const constraints = rows(db, `
    SELECT c.relname AS tab, con.conname AS name, con.contype::text AS type,
           pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT c.relispartition
    ORDER BY 1, 2
  `);

  const indexes = rows(db, `
    SELECT c.relname AS tab, ic.relname AS name, pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT c.relispartition
      AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)
    ORDER BY 1, 2
  `);

  const acls = rows(db, `
    SELECT c.relname AS tab, a.grantee::regrole::text AS role, a.privilege_type AS priv
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v') AND NOT c.relispartition
      AND a.grantee::regrole::text = ANY('{${MANAGED_ROLES.join(",")}}')
    ORDER BY 1, 2, 3
  `);

  const colAcls = rows(db, `
    SELECT c.relname AS tab, att.attname AS col, a.grantee::regrole::text AS role,
           a.privilege_type AS priv
    FROM pg_attribute att
    JOIN pg_class c ON c.oid = att.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace,
         LATERAL aclexplode(att.attacl) a
    WHERE n.nspname = 'public' AND att.attacl IS NOT NULL AND NOT c.relispartition
      AND a.grantee::regrole::text = ANY('{${MANAGED_ROLES.join(",")}}')
    ORDER BY 1, 2, 3, 4
  `);

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
      grants: [
        ...acls.filter((a) => a.tab === t.name).map((a) => `${a.role}:${a.priv}`),
        ...colAcls.filter((a) => a.tab === t.name).map((a) => `${a.role}:${a.priv}(${a.col})`),
      ].sort(),
    };
  }

  const policies = rows(db, `
    SELECT schemaname || '.' || tablename AS tab, policyname AS name,
           permissive, cmd, roles::text[] AS roles, qual, with_check
    FROM pg_policies
    WHERE (schemaname = 'public' OR schemaname || '.' || tablename = ANY('{${EXTERNAL_POLICY_TABLES.join(",")}}'))
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
    SELECT c.relname AS tab, t.tgname AS name, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal AND NOT c.relispartition
    ORDER BY 1, 2
  `);
  ir.triggers = Object.fromEntries(triggers.map((t) => [`${t.tab}:${t.name}`, t.def]));

  const funcs = rows(db, `
    SELECT p.proname AS name,
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
           (SELECT json_agg(a.grantee::regrole::text ORDER BY a.grantee::regrole::text)
              FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             WHERE a.privilege_type = 'EXECUTE'
               AND a.grantee::regrole::text = ANY('{${MANAGED_ROLES.join(",")}}')) AS grants
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      -- extension-owned functions are the extension's business, not the spec's
      AND NOT EXISTS (SELECT 1 FROM pg_depend dep
                      WHERE dep.objid = p.oid AND dep.deptype = 'e')
    ORDER BY 1, 2
  `);
  ir.functions = Object.fromEntries(
    funcs.map((f) => [
      `${f.name}(${f.identity_args})`,
      { args: f.args, returns: f.returns, language: f.language, volatility: f.volatility,
        strict: f.strict, security_definer: f.security_definer, config: f.config ?? null,
        body: f.body, public_execute: f.public_execute, grants: f.grants ?? [] },
    ]),
  );

  const views = rows(db, `
    SELECT c.relname AS name, pg_get_viewdef(c.oid) AS def,
           coalesce(c.reloptions::text LIKE '%security_invoker=%true%'
                 OR c.reloptions::text LIKE '%security_invoker=on%', false) AS security_invoker,
           (SELECT json_agg(json_build_array(a.attname, format_type(a.atttypid, a.atttypmod))
                   ORDER BY a.attnum)
              FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'v'
    ORDER BY 1
  `);
  ir.views = Object.fromEntries(
    views.map((v) => [v.name, {
      def: v.def, security_invoker: v.security_invoker, columns: v.columns,
      grants: acls.filter((a) => a.tab === v.name).map((a) => `${a.role}:${a.priv}`).sort(),
    }]),
  );

  if (cron) {
    ir.cron = Object.fromEntries(
      rows(db, `
        SELECT jobname AS name, schedule, btrim(command, E' \\n\\t') AS command
        FROM cron.job ORDER BY 1
      `).map((c) => [c.name, { schedule: c.schedule, command: c.command }]),
    );
  }

  return ir;
}
