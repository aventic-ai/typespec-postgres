// Emitter: compiled TypeSpec program + pgspec decorator state → ordered DDL.
// The DDL only has to be VALID — the shadow database normalizes it; it never
// has to match Postgres's printing.
import { compile, NodeHost, getSourceLocation } from "@typespec/compiler";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { modelState, opState, propState } from "../lib/index.js";
import { lintLayers } from "./lint.mjs";

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
  if (type.kind === "Enum") return type.name;
  if (type.kind === "Model" && type.name === "Array") return `${pgType(type.indexer.value)}[]`;
  if (type.kind === "Model") return type.name;   // table/composite reference
  if (type.kind === "Intrinsic" && type.name === "void") return "void";
  throw new Error(`unmapped type kind ${type.kind}/${type.name}`);
}

const q = (name) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`);

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
      return `${litToSql(typeof m.value === "string" ? m.value : m.name)}::${m.enum.name}`;
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
  const pub = glob.namespaces.get("public");
  if (!pub) throw new Error("no `public` namespace in spec");

  // alters: non-FK constraints (unique/check) must all land before any FK,
  // since FKs may target uniques on other tables.
  const out = { types: [], sequences: [], tables: [], functions: [], alters: [], fks: [], indexes: [],
    triggers: [], rls: [], policies: [], grants: [], views: [] };
  const sequences = new Set();
  const cron = {};
  const projections = {};   // view name -> declared [[column, pgType], ...]
  const opPgName = new Map();   // Operation type -> pg function name

  // enums
  for (const [, en] of pub.enums) {
    const labels = [...en.members.values()].map((m) => litToSql(typeof m.value === "string" ? m.value : m.name));
    out.types.push(`CREATE TYPE public.${q(en.name)} AS ENUM (${labels.join(", ")});`);
  }

  // ops: functions + cron
  const opsEverywhere = [];
  const collectOps = (ns) => { for (const [, op] of ns.operations) opsEverywhere.push(op); };
  collectOps(pub);
  const cronNs = glob.namespaces.get("cron");
  if (cronNs) collectOps(cronNs);

  for (const op of opsEverywhere) {
    const st = opState(op);
    if (st.schedule || st.command) {
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
    const loc = getSourceLocation(op);
    const body = readFileSync(join(dirname(loc.file.path), st.fn.body ?? `./fn/${op.name}.sql`), "utf8").trimEnd();
    let tag = "$function$";
    while (body.includes(tag)) tag = tag.replace("$", "$x");
    out.functions.push(
      `CREATE FUNCTION public.${q(pgName)}(${params.join(", ")}) RETURNS ${ret}\n` +
      `LANGUAGE ${language}${rest ? " " + rest : ""}\nAS ${tag}\n${body}\n${tag};`,
    );
    const sig = `public.${q(pgName)}(${params.map((p) => p.split(" DEFAULT ")[0]).join(", ")})`;
    out.grants.push(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC;`);
    for (const g of opState(op).grants ?? []) {
      out.grants.push(`GRANT EXECUTE ON FUNCTION ${sig} TO ${g.role === "public" ? "PUBLIC" : q(g.role)};`);
    }
  }

  // models: tables, views, external
  const viewDefs = [];
  for (const [, model] of pub.models) {
    const st = modelState(model);
    if (st.external) continue;
    if (st.view) {
      const loc = getSourceLocation(model);
      const body = readFileSync(join(dirname(loc.file.path), st.view.body ?? `./views/${model.name}.sql`), "utf8").trim();
      viewDefs.push({ name: model.name, body, invoker: !!st.security_invoker, grants: st.grants ?? [] });
      projections[model.name] = [...model.properties.values()].map((p) => [p.name, pgType(p.type, propState(p))]);
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
        // serial-style defaults imply their sequence; create it first
        const seq = def.match(/nextval\('(?:public\.)?([^':]+)'/)?.[1];
        if (seq) sequences.add(seq);
      }
      if (!p.optional && !ps.generated) c += " NOT NULL";
      if (ps.generated && !p.optional) c += " NOT NULL";
      cols.push("  " + c);
      for (const chk of ps.checks ?? []) {
        // checks may call spec functions, which are created after tables
        tableAlters.push(`ALTER TABLE public.${q(model.name)} ADD CONSTRAINT ${q(chk.name ?? `${model.name}_${p.name}_check`)} CHECK ${chk.expr};`);
      }
      if (ps.references) {
        const { ref, actions, name } = ps.references;
        const cname = name || `${model.name}_${p.name}_fkey`;
        out.fks.push(
          `ALTER TABLE public.${q(model.name)} ADD CONSTRAINT ${q(cname)} FOREIGN KEY (${q(p.name)}) ` +
          `REFERENCES public.${q(ref.model.name)}(${q(ref.name)})${actions ? " " + actions : ""};`,
        );
      }
    }
    for (const chk of st.checks ?? []) {
      tableAlters.push(`ALTER TABLE public.${q(model.name)} ADD CONSTRAINT ${q(chk.name ?? `${model.name}_check`)} CHECK ${chk.expr};`);
    }
    if (st.pk) {
      cols.push(`  CONSTRAINT ${q(st.pk.name ?? `${model.name}_pkey`)} PRIMARY KEY (${st.pk.cols}),`);
    }
    const body = cols.map((c) => (c.endsWith(",") ? c : c + ",")).join("\n").replace(/,$/, "");
    const partition = st.partition_by ? ` PARTITION BY ${st.partition_by}` : "";
    out.tables.push(`CREATE TABLE public.${q(model.name)} (\n${body}\n)${partition};`);
    out.alters.push(...tableAlters);
    for (const con of st.constraints ?? []) {
      const bucket = con.def.startsWith("FOREIGN KEY") ? out.fks : out.alters;
      bucket.push(`ALTER TABLE public.${q(model.name)} ADD CONSTRAINT ${q(con.name)} ${con.def};`);
    }
    if (st.rls) out.rls.push(`ALTER TABLE public.${q(model.name)} ENABLE ROW LEVEL SECURITY;`);
    for (const tail of st.indexes ?? []) {
      const m = tail.match(/^(unique )?(\S+) (.+)$/s);
      out.indexes.push(`CREATE ${m[1] ? "UNIQUE " : ""}INDEX ${q(m[2])} ON public.${q(model.name)} ${m[3]};`);
    }
    for (const pol of st.policies ?? []) {
      out.policies.push(`CREATE POLICY "${pol.name.replaceAll('"', '""')}" ON public.${q(model.name)}\n${pol.tail};`);
    }
    for (const trg of st.triggers ?? []) {
      const [events, rest] = trg.fires.split(/\s+(?=FOR EACH\s)/i);
      const fnName = opPgName.get(trg.execute) ?? trg.execute.name;
      out.triggers.push(
        `CREATE TRIGGER ${q(trg.name)} ${events} ON public.${q(model.name)} ${rest ?? "FOR EACH STATEMENT"} ` +
        `EXECUTE FUNCTION public.${q(fnName)}();`,
      );
    }
    for (const g of st.grants ?? []) {
      out.grants.push(`GRANT ${g.privileges} ON public.${q(model.name)} TO ${q(g.role)};`);
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

  // views: dependency-ordered (a view referencing another view comes later)
  const names = new Set(viewDefs.map((v) => v.name));
  const ordered = [];
  const placed = new Set();
  let guard = viewDefs.length + 1;
  while (ordered.length < viewDefs.length && guard--) {
    for (const v of viewDefs) {
      if (placed.has(v.name)) continue;
      const deps = [...names].filter((n) => n !== v.name && new RegExp(`\\b${n}\\b`).test(v.body));
      if (deps.every((d) => placed.has(d))) { ordered.push(v); placed.add(v.name); }
    }
  }
  for (const v of viewDefs.filter((v) => !placed.has(v.name))) ordered.push(v);   // cycles: let PG error
  for (const v of ordered) {
    const opt = v.invoker ? " WITH (security_invoker=true)" : "";
    out.views.push(`CREATE VIEW public.${q(v.name)}${opt} AS\n${v.body}`);
    for (const g of v.grants) out.views.push(`GRANT ${g.privileges} ON public.${q(v.name)} TO ${q(g.role)};`);
  }

  out.sequences.push(...[...sequences].sort().map((s) => `CREATE SEQUENCE public.${q(s)};`));
  const ddl = [
    "SET check_function_bodies = off;",
    ...out.types, ...out.sequences, ...out.tables, ...out.functions, ...out.alters, ...out.fks, ...out.indexes,
    ...out.triggers, ...out.rls, ...out.policies, ...out.grants, ...out.views,
  ].join("\n\n");
  return { ddl, cron, projections };
}
