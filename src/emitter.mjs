// Emitter: compiled TypeSpec program + pgspec decorator state → ordered DDL.
// The DDL only has to be VALID — the shadow database normalizes it; it never
// has to match Postgres's printing.
import { compile, NodeHost, getSourceLocation } from "@typespec/compiler";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { modelState, opState, propState } from "../lib/index.js";
import { lintLayers } from "./lint.mjs";
import { IDENTIFIER, MANAGED_ROLES, PLAIN_IDENTIFIER, catalogKey, declaredSchemas } from "./schemas.mjs";

const SCALAR_TO_PG = {
  text_s: "text", uuid_s: "uuid", timestamptz_s: "timestamp with time zone",
  timestamp_s: "timestamp without time zone", integer_s: "integer", jsonb_s: "jsonb",
  json_s: "json", boolean_s: "boolean", bigint_s: "bigint", smallint_s: "smallint",
  numeric_s: "numeric", date_s: "date", bytea_s: "bytea", float8_s: "double precision",
  inet_s: "inet", trigger: "trigger",
};

function pgType(type, st = {}) {
  if (st.pg_type) return st.pg_type;
  if (type.kind === "Union") {
    // the lib's X = X_s | sql aliases (and the explicit array escape):
    // the sql marker carries defaults, never the column's type
    const real = [...type.variants.values()].map((v) => v.type)
      .find((t) => !(t.kind === "Scalar" && t.name === "sql"));
    return pgType(real, st);
  }
  if (type.kind === "Scalar") return SCALAR_TO_PG[type.name] ?? type.name;
  if (type.kind === "Enum") return typeRef(type);
  if (type.kind === "Model" && type.name === "Array") return `${pgType(type.indexer.value)}[]`;
  if (type.kind === "Model") return typeRef(type);   // table/composite reference
  if (type.kind === "Intrinsic" && type.name === "void") return "void";
  throw new Error(`unmapped type kind ${type.kind}/${type.name}`);
}

const q = (name) => (PLAIN_IDENTIFIER.test(name) ? name : `"${name.replaceAll('"', '""')}"`);
const rel = (schema, name) => `${q(schema)}.${q(name)}`;

// The schema a declaration lives in is its namespace, whether or not the spec
// owns it: a table another system owns is still referenced where it is. The
// one exception is pg_cron's job list, whose functions land in `public`.
function schemaOf(type) {
  const name = type.namespace?.name;
  return !name || name === "cron" ? "public" : name;
}
const qualified = (type, name = type.name) => rel(schemaOf(type), name);

// A type reads bare inside `public`, which every session searches, and
// qualified anywhere else, which none does.
const typeRef = (type) => (schemaOf(type) === "public" ? type.name : qualified(type));

// A serial-style default, with the schema it names when it names one.
const NEXTVAL = new RegExp(`nextval\\('(?:(${IDENTIFIER})\\.)?([^':.]+)'`);

// The check reads a PostgREST role's reach into a schema beside `public` as
// drift, so a grant to one inside it could never be used. Refuse it rather
// than emit a privilege that only looks like access.
function assertGrantable(type, name, grants) {
  const schema = schemaOf(type);
  if (schema === "public") return;
  const dead = grants.find((g) => MANAGED_ROLES.includes(g.role));
  if (!dead) return;
  throw new Error(
    `${dead.role} cannot be granted anything on ${rel(schema, name)}: schema ${schema} is closed to the ` +
    `PostgREST roles, and USAGE on it is drift`,
  );
}

function litToSql(v) {
  if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
  return String(v);
}

// A default in value position, by value kind: sql.of(expr) is verbatim SQL;
// everything else is a literal — the bright line is structural.
function valueToSql(dv) {
  switch (dv.valueKind) {
    case "ScalarValue":
      if (dv.value.name !== "of") throw new Error(`unsupported constructor ${dv.value.name} in default`);
      return dv.value.args[0].value;
    case "StringValue": return litToSql(dv.value);
    case "NumericValue": return String(dv.value.asNumber() ?? dv.value.asBigInt());
    case "BooleanValue": return String(dv.value);
    case "EnumValue": {
      const m = dv.value;
      return `${litToSql(typeof m.value === "string" ? m.value : m.name)}::${typeRef(m.enum)}`;
    }
  }
  throw new Error(`unsupported default value kind ${dv.valueKind}`);
}

export async function emit(mainTsp) {
  const program = await compile(NodeHost, mainTsp, {});
  const errs = program.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) {
    throw new Error(`spec does not compile:\n${errs.slice(0, 10).map((e) => `${e.code}: ${e.message}`).join("\n")}`);
  }
  const layering = lintLayers(program);
  if (layering.length) {
    throw new Error(`spec does not lint:\n${layering.slice(0, 10).map((v) => `${v.file}:${v.line} ${v.message}`).join("\n")}`);
  }
  const glob = program.getGlobalNamespaceType();
  const schemas = declaredSchemas(glob);
  const namespaces = schemas.map((name) => glob.namespaces.get(name));

  // alters: non-FK constraints (unique/check) must all land before any FK,
  // since FKs may target uniques on other tables.
  const out = { schemas: [], types: [], sequences: [], tables: [], functions: [], alters: [], fks: [], indexes: [],
    triggers: [], rls: [], policies: [], grants: [], views: [] };
  const sequences = new Set();
  const cron = {};
  const projections = {};   // view catalog key -> declared [[column, pgType], ...]
  const opPgName = new Map();   // Operation type -> pg function name

  // Two declarations that leave their body to the default path and share a
  // name and a directory would read one file, the second taking the first's SQL.
  const defaultBodies = new Map();   // file -> the declaration that reads it
  const readBody = (type, explicit, byDefault, owner) => {
    const file = join(dirname(getSourceLocation(type).file.path), explicit ?? byDefault);
    if (!explicit) {
      const other = defaultBodies.get(file);
      if (other) throw new Error(`${other} and ${owner} both read ${byDefault}: name a body file on one of them`);
      defaultBodies.set(file, owner);
    }
    return readFileSync(file, "utf8");
  };

  // `public` exists in every database; any other schema the spec declares is its to create
  out.schemas.push(...schemas.filter((name) => name !== "public").map((name) => `CREATE SCHEMA ${q(name)};`));

  // enums
  for (const en of namespaces.flatMap((ns) => [...ns.enums.values()])) {
    const labels = [...en.members.values()].map((m) => litToSql(typeof m.value === "string" ? m.value : m.name));
    out.types.push(`CREATE TYPE ${qualified(en)} AS ENUM (${labels.join(", ")});`);
  }

  // ops: functions + cron
  const opsEverywhere = [];
  const collectOps = (ns) => { for (const [, op] of ns.operations) opsEverywhere.push(op); };
  namespaces.forEach(collectOps);
  const cronNs = glob.namespaces.get("cron");
  if (cronNs) collectOps(cronNs);

  for (const op of opsEverywhere) {
    const st = opState(op);
    if (st.schedule || st.command) {
      if (cron[op.name]) throw new Error(`two ops named ${op.name} carry a schedule: a name is one job in pg_cron`);
      cron[op.name] = { schedule: st.schedule, command: st.command };
      continue;
    }
    if (!st.fn) continue;   // plain op with no @function: nothing to emit
    const [options, bodyPath] = Array.isArray(st.fn.options) ? st.fn.options : [st.fn.options, st.fn.body];
    const pgName = st.pg_name ?? op.name;
    opPgName.set(op, pgName);

    const params = [...op.parameters.properties.values()].map((p) => {
      const ps = propState(p);
      let s = `${q(p.name)} ${pgType(p.type, ps)}`;
      if (p.defaultValue) s += ` DEFAULT ${valueToSql(p.defaultValue)}`;
      else if (p.optional) s += ` DEFAULT NULL`;
      return s;
    });

    let ret;
    const rt = op.returnType;
    if (rt.kind === "Model" && rt.name === "Array") {
      const el = rt.indexer.value;
      if (el.kind === "Model" && el.name === "") {
        const cols = [...el.properties.values()]
          .map((p) => `${q(p.name)} ${pgType(p.type, propState(p))}`);
        ret = `TABLE(${cols.join(", ")})`;
      } else {
        ret = `SETOF ${pgType(el)}`;
      }
    } else {
      ret = pgType(rt);
    }

    const words = st.fn.options.split(/\s+/);
    const language = words[0];
    const rest = st.fn.options.slice(language.length).trim();
    const body = readBody(op, st.fn.body, `./fn/${op.name}.sql`, qualified(op, pgName)).trimEnd();
    let tag = "$function$";
    while (body.includes(tag)) tag = tag.replace("$", "$x");
    out.functions.push(
      `CREATE FUNCTION ${qualified(op, pgName)}(${params.join(", ")}) RETURNS ${ret}\n` +
      `LANGUAGE ${language}${rest ? " " + rest : ""}\nAS ${tag}\n${body}\n${tag};`,
    );
    const sig = `${qualified(op, pgName)}(${params.map((p) => p.split(" DEFAULT ")[0]).join(", ")})`;
    out.grants.push(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC;`);
    assertGrantable(op, pgName, st.grants ?? []);
    for (const g of st.grants ?? []) {
      out.grants.push(`GRANT EXECUTE ON FUNCTION ${sig} TO ${g.role === "public" ? "PUBLIC" : q(g.role)};`);
    }
  }

  // models: tables, views, external
  const viewDefs = [];
  for (const model of namespaces.flatMap((ns) => [...ns.models.values()])) {
    const st = modelState(model);
    if (st.external) continue;
    const table = qualified(model);
    assertGrantable(model, model.name, st.grants ?? []);
    if (st.view) {
      const body = readBody(model, st.view.body, `./views/${model.name}.sql`, table).trim();
      viewDefs.push({ name: model.name, rel: table, body, invoker: !!st.security_invoker, grants: st.grants ?? [] });
      projections[catalogKey(schemaOf(model), model.name)] =
        [...model.properties.values()].map((p) => [p.name, pgType(p.type, propState(p))]);
      continue;
    }

    const cols = [];
    const tableAlters = [];
    for (const [, p] of model.properties) {
      const ps = propState(p);
      let c = `${q(p.name)} ${pgType(p.type, ps)}`;
      if (ps.generated) c += ` GENERATED ALWAYS AS (${ps.generated}) STORED`;
      else if (ps.identity) c += ` GENERATED ${ps.identity === "always" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
      else if (p.defaultValue) {
        const def = valueToSql(p.defaultValue);
        c += ` DEFAULT ${def}`;
        // serial-style defaults imply their sequence; create it first, in the
        // schema the default names — unqualified, that is `public`
        const seq = def.match(NEXTVAL);
        if (seq) sequences.add(rel(seq[1] ?? "public", seq[2]));
      }
      if (!p.optional && !ps.generated) c += " NOT NULL";
      if (ps.generated && !p.optional) c += " NOT NULL";
      cols.push("  " + c);
      for (const chk of ps.checks ?? []) {
        // checks may call spec functions, which are created after tables
        tableAlters.push(`ALTER TABLE ${table} ADD CONSTRAINT ${q(chk.name ?? `${model.name}_${p.name}_check`)} CHECK ${chk.expr};`);
      }
      if (ps.references) {
        const { ref, actions, name } = ps.references;
        const cname = name || `${model.name}_${p.name}_fkey`;
        out.fks.push(
          `ALTER TABLE ${table} ADD CONSTRAINT ${q(cname)} FOREIGN KEY (${q(p.name)}) ` +
          `REFERENCES ${qualified(ref.model)}(${q(ref.name)})${actions ? " " + actions : ""};`,
        );
      }
    }
    for (const chk of st.checks ?? []) {
      tableAlters.push(`ALTER TABLE ${table} ADD CONSTRAINT ${q(chk.name ?? `${model.name}_check`)} CHECK ${chk.expr};`);
    }
    if (st.pk) {
      cols.push(`  CONSTRAINT ${q(st.pk.name ?? `${model.name}_pkey`)} PRIMARY KEY (${st.pk.cols}),`);
    }
    const body = cols.map((c) => (c.endsWith(",") ? c : c + ",")).join("\n").replace(/,$/, "");
    const partition = st.partition_by ? ` PARTITION BY ${st.partition_by}` : "";
    out.tables.push(`CREATE TABLE ${table} (\n${body}\n)${partition};`);
    out.alters.push(...tableAlters);
    for (const con of st.constraints ?? []) {
      const bucket = con.def.startsWith("FOREIGN KEY") ? out.fks : out.alters;
      bucket.push(`ALTER TABLE ${table} ADD CONSTRAINT ${q(con.name)} ${con.def};`);
    }
    if (st.rls) out.rls.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    for (const tail of st.indexes ?? []) {
      const m = tail.match(/^(unique )?(\S+) (.+)$/s);
      out.indexes.push(`CREATE ${m[1] ? "UNIQUE " : ""}INDEX ${q(m[2])} ON ${table} ${m[3]};`);
    }
    for (const pol of st.policies ?? []) {
      out.policies.push(`CREATE POLICY "${pol.name.replaceAll('"', '""')}" ON ${table}\n${pol.tail};`);
    }
    for (const trg of st.triggers ?? []) {
      const [events, rest] = trg.fires.split(/\s+(?=FOR EACH\s)/i);
      const fnName = opPgName.get(trg.execute) ?? trg.execute.name;
      out.triggers.push(
        `CREATE TRIGGER ${q(trg.name)} ${events} ON ${table} ${rest ?? "FOR EACH STATEMENT"} ` +
        `EXECUTE FUNCTION ${qualified(trg.execute, fnName)}();`,
      );
    }
    for (const g of st.grants ?? []) {
      out.grants.push(`GRANT ${g.privileges} ON ${table} TO ${q(g.role)};`);
    }
  }

  // external-model policies (storage.objects, realtime.messages)
  for (const nsName of ["storage", "realtime"]) {
    const ns = glob.namespaces.get(nsName);
    if (!ns) continue;
    for (const [, model] of ns.models) {
      const st = modelState(model);
      for (const pol of st.policies ?? []) {
        out.policies.push(`CREATE POLICY "${pol.name.replaceAll('"', '""')}" ON ${nsName}.${q(model.name)}\n${pol.tail};`);
      }
    }
  }

  // views: dependency-ordered (a view referencing another view comes later).
  // A dependency is any other view the body names. Matching on the name alone
  // can make a view wait needlessly for a same-named one in another schema;
  // skipping same-named views instead emits one before the view it selects from.
  const deps = new Map(viewDefs.map((v) => [
    v, viewDefs.filter((d) => d !== v && new RegExp(`\\b${d.name}\\b`).test(v.body)),
  ]));
  const ordered = [];
  const placed = new Set();
  let guard = viewDefs.length + 1;
  while (ordered.length < viewDefs.length && guard--) {
    for (const v of viewDefs) {
      if (placed.has(v)) continue;
      if (deps.get(v).every((d) => placed.has(d))) { ordered.push(v); placed.add(v); }
    }
  }
  for (const v of viewDefs.filter((v) => !placed.has(v))) ordered.push(v);   // cycles: let PG error
  for (const v of ordered) {
    const opt = v.invoker ? " WITH (security_invoker=true)" : "";
    out.views.push(`CREATE VIEW ${v.rel}${opt} AS\n${v.body}`);
    for (const g of v.grants) out.views.push(`GRANT ${g.privileges} ON ${v.rel} TO ${q(g.role)};`);
  }

  out.sequences.push(...[...sequences].sort().map((s) => `CREATE SEQUENCE ${s};`));
  const ddl = [
    "SET check_function_bodies = off;",
    ...out.schemas, ...out.types, ...out.sequences, ...out.tables, ...out.functions, ...out.alters, ...out.fks,
    ...out.indexes, ...out.triggers, ...out.rls, ...out.policies, ...out.grants, ...out.views,
  ].join("\n\n");
  return { ddl, cron, projections, schemas };
}
