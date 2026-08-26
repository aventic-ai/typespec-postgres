// Bootstrap generator: live-catalog IR → domain-grouped spec/db TypeSpec.
// Raw transcription per goal.md doctrine: zero abstraction, verbatim SQL.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ident, str, block, sqlArg, mapType } from "./gen-util.mjs";
import { domainOf, enumOwner, storageBucketDomain, realtimeTopicDomain, cronOwner } from "./domains.mjs";

/** Split on top-level commas (ignoring parens, brackets, quotes). */
function splitTop(s) {
  const out = [];
  let depth = 0, q = null, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q && s[i - 1] !== "\\") q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function generate(ir, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  const files = new Map();   // relative path -> array of chunks
  const notes = [];
  const unknowns = new Set();
  const typeCtx = { enums: ir.enums, tables: ir.tables, unknowns };
  const emit = (path, chunk) => {
    if (!files.has(path)) files.set(path, []);
    files.get(path).push(chunk);
  };
  const header = (path, ns) => {
    if (!files.has(path)) files.set(path, [ns ? `namespace ${ns};` : null].filter(Boolean));
  };

  // ── overload map: proname → tsp op name ─────────────────────────────
  const fnKeys = Object.keys(ir.functions).sort();
  const byName = {};
  for (const k of fnKeys) (byName[k.replace(/\(.*/s, "")] ??= []).push(k);
  const opNameOf = {};   // fn key -> tsp op name
  for (const [name, keys] of Object.entries(byName))
    keys.forEach((k, i) => (opNameOf[k] = i === 0 ? name : `${name}__overload${i + 1}`));

  // ── enums ───────────────────────────────────────────────────────────
  for (const [name, labels] of Object.entries(ir.enums)) {
    const domain = enumOwner(name, ir.tables);
    const path = `${domain}/types.tsp`;
    header(path, "`public`");
    const members = labels.map((l) => {
      const m = l.replaceAll(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1");
      return m === l ? `  ${ident(m)},` : `  ${ident(m)}: ${str(l)},`;
    });
    emit(path, `enum ${ident(name)} {\n${members.join("\n")}\n}`);
  }

  // ── tables ──────────────────────────────────────────────────────────
  for (const [tab, t] of Object.entries(ir.tables)) {
    const domain = domainOf(tab);
    const path = `${domain}/${tab}.tsp`;
    header(path, "`public`");
    const decs = [];
    if (t.rls) decs.push("@rls");
    const fkProps = {};       // column -> {reftab, refcol, tail, name}
    for (const [cname, c] of Object.entries(t.constraints)) {
      if (c.type === "p") {
        const cols = c.def.match(/^PRIMARY KEY \((.+)\)$/)?.[1];
        decs.push(`@pk(${str(cols)}${cname === `${tab}_pkey` ? "" : `, ${str(cname)}`})`);
      } else if (c.type === "c") {
        const expr = c.def.replace(/^CHECK /, "");
        decs.push(`@check(${sqlArg(expr, 0)}, ${str(cname)})`);
      } else if (c.type === "f") {
        const m = c.def.match(/^FOREIGN KEY \(([^)]+)\) REFERENCES (?:public\.)?("?[\w]+"?)\(([^)]+)\)\s*(.*)$/s);
        const cols = m ? splitTop(m[1]) : [];
        const refTab = m?.[2]?.replaceAll('"', "");
        if (m && cols.length === 1 && ir.tables[refTab] && splitTop(m[3]).length === 1) {
          const col = cols[0].replaceAll('"', "");
          fkProps[col] = {
            reftab: refTab, refcol: m[3].trim().replaceAll('"', ""),
            tail: m[4].trim() || null,
            name: cname === `${tab}_${col}_fkey` ? null : cname,
          };
        } else {
          decs.push(`@constraint(${str(cname)}, ${sqlArg(c.def, 0)})`);
        }
      } else {
        decs.push(`@constraint(${str(cname)}, ${sqlArg(c.def, 0)})`);
      }
    }
    if (t.partitioned) {
      decs.push(`@partition_by(${str(t.partkey)})`);
      decs.push(`@unmanaged_partitions(${str(`${tab}_%`)})`);
    }
    for (const g of formatGrants(t.grants)) decs.push(g);

    const props = t.columns.map((c) => {
      const pd = [];
      const { tsp, pgType } = mapType(c.type, typeCtx);
      if (pgType) pd.push(`@pg_type(${str(pgType)})`);
      if (c.generated) pd.push(`@generated(${sqlArg(c.default, 4)})`);
      else if (c.identity) pd.push(`@identity(${str(c.identity === "a" ? "always" : "by default")})`);
      else if (c.default != null) pd.push(`@default(${sqlArg(c.default, 4)})`);
      const fk = fkProps[c.name];
      if (fk) {
        const args = [`${ident(fk.reftab)}.${ident(fk.refcol)}`];
        if (fk.tail || fk.name) args.push(str(fk.tail ?? ""));
        if (fk.name) args.push(str(fk.name));
        pd.push(`@references(${args.join(", ")})`);
      }
      const line = `${pd.length ? pd.join(" ") + " " : ""}${ident(c.name)}${c.notnull ? "" : "?"}: ${tsp};`;
      return line.length <= 100 || pd.length === 0
        ? `  ${line}`
        : `  ${pd.join("\n  ")}\n  ${ident(c.name)}${c.notnull ? "" : "?"}: ${tsp};`;
    });

    emit(path, `${decs.join("\n")}${decs.length ? "\n" : ""}model ${ident(tab)} {\n${props.join("\n")}\n}`);

    for (const [iname, def] of Object.entries(t.indexes)) {
      const m = def.match(/^CREATE (UNIQUE )?INDEX (\S+) ON (?:ONLY )?public\.(\S+) (.+)$/s);
      if (!m) { notes.push(`unparsed index def: ${def}`); continue; }
      const tail = `${m[1] ? "unique " : ""}${iname} ${m[4]}`;
      emit(path, `@@index(${ident(tab)}, ${sqlArg(tail, 0)});`);
    }
  }

  // ── policies (public tables → their table file) ─────────────────────
  for (const [key, p] of Object.entries(ir.policies)) {
    const [tabFull, ...nameParts] = key.split(":");
    const pname = nameParts.join(":");
    const [schema, tab] = tabFull.split(".");
    const tail = policyTail(p);
    if (schema === "public") {
      const path = `${domainOf(tab)}/${tab}.tsp`;
      header(path, "`public`");
      emit(path, `@@policy(${ident(tab)}, ${str(pname)}, ${sqlArg(tail, 0)});`);
    } else if (tabFull === "storage.objects") {
      const bucket = `${p.qual ?? ""} ${p.with_check ?? ""}`.match(/bucket_id = '([^']+)'/)?.[1];
      const path = `${storageBucketDomain(bucket)}/storage.tsp`;
      header(path, null);
      emit(path, `// bucket: ${bucket ?? "(no single bucket)"}\n@@policy(storage.objects, ${str(pname)}, ${sqlArg(tail, 0)});`);
    } else if (tabFull === "realtime.messages") {
      const path = `${realtimeTopicDomain(pname, p.qual)}/realtime.tsp`;
      header(path, null);
      emit(path, `@@policy(realtime.messages, ${str(pname)}, ${sqlArg(tail, 0)});`);
    }
  }

  // ── triggers ────────────────────────────────────────────────────────
  for (const [key, def] of Object.entries(ir.triggers)) {
    const [tab, tname] = key.split(":");
    const m = def.match(/^CREATE TRIGGER (\S+) (.+?) ON public\.(\S+) (.+?) EXECUTE FUNCTION (?:public\.)?([A-Za-z0-9_]+)\((.*)\)$/s);
    if (!m) { notes.push(`unparsed trigger def: ${def}`); continue; }
    if (m[6] !== "") { notes.push(`trigger with function args unsupported: ${def}`); continue; }
    const fires = `${m[2]} ${m[4]}`;
    const path = `${domainOf(tab)}/${tab}.tsp`;
    header(path, "`public`");
    emit(path, `@@trigger(${ident(tab)}, ${str(tname)}, ${sqlArg(fires, 0)}, ${ident(m[5])});`);
  }

  // ── functions ───────────────────────────────────────────────────────
  const bodies = new Map();
  for (const key of fnKeys) {
    const f = ir.functions[key];
    const name = key.replace(/\(.*/s, "");
    const opName = opNameOf[key];
    const domain = domainOf(name);
    const path = `${domain}/functions.tsp`;
    header(path, "`public`");

    const params = f.args ? splitTop(f.args).map((a) => {
      const pm = a.match(/^(?:IN )?("?[\w]+"?) (.+?)(?: DEFAULT (.+))?$/s);
      if (!pm) throw new Error(`unparsed param '${a}' in ${key}`);
      const [, pname, ptype, pdef] = pm;
      const { tsp, pgType } = mapType(ptype.trim(), typeCtx);
      const pd = pgType ? `@pg_type(${str(pgType)}) ` : "";
      if (pdef == null) return `  ${pd}${ident(pname.replaceAll('"', ""))}: ${tsp},`;
      if (/^NULL(::|$)/.test(pdef.trim())) return `  ${pd}${ident(pname.replaceAll('"', ""))}?: ${tsp},`;
      return `  ${pd}@arg_default(${str(pdef.trim())}) ${ident(pname.replaceAll('"', ""))}?: ${tsp},`;
    }) : [];

    let ret;
    const r = f.returns;
    if (r.startsWith("TABLE(")) {
      const cols = splitTop(r.slice(6, -1)).map((c) => {
        const cm = c.match(/^("?[\w]+"?) (.+)$/s);
        const { tsp, pgType } = mapType(cm[2].trim(), typeCtx);
        return `  ${pgType ? `@pg_type(${str(pgType)}) ` : ""}${ident(cm[1].replaceAll('"', ""))}: ${tsp},`;
      });
      ret = `{\n${cols.join("\n")}\n}[]`;
    } else if (r.startsWith("SETOF ")) {
      ret = `${mapType(r.slice(6).trim(), typeCtx).tsp}[]`;
    } else {
      ret = mapType(r, typeCtx).tsp;
    }

    const opts = [
      f.language,
      f.volatility === "i" ? "immutable" : f.volatility === "s" ? "stable" : null,
      f.strict ? "strict" : null,
      f.security_definer ? "security definer" : null,
      ...(f.config ?? []).map((c) => {
        const i = c.indexOf("=");
        // proconfig prints an empty search_path as "" — DDL spells it ''
        const v = c.slice(i + 1) === '""' ? "''" : c.slice(i + 1);
        return `set ${c.slice(0, i)} = ${v}`;
      }),
    ].filter(Boolean).join(" ");

    const decs = [`@function(${str(opts)})`];
    if (opName !== name) decs.push(`@pg_name(${str(name)})`);
    for (const role of f.grants) decs.push(`@grant(${str(role)}, "execute")`);
    if (f.public_execute) decs.push(`@grant("public", "execute")`);

    const sig = params.length
      ? `op ${ident(opName)}(\n${params.join("\n")}\n): ${ret};`
      : `op ${ident(opName)}(): ${ret};`;
    emit(path, `${decs.join("\n")}\n${sig}`);
    bodies.set(`${domain}/fn/${opName}.sql`, f.body + "\n");
  }

  // ── views ───────────────────────────────────────────────────────────
  for (const [vname, v] of Object.entries(ir.views)) {
    const domain = domainOf(vname);
    const path = `${domain}/views.tsp`;
    header(path, "`public`");
    const decs = [
      v.security_invoker ? "@security_invoker" : "@security_definer",
      "@view",
      ...formatGrants(v.grants ?? []),
    ];
    const props = (v.columns ?? []).map(([cname, ctype]) => {
      const { tsp, pgType } = mapType(ctype, typeCtx);
      return `  ${pgType ? `@pg_type(${str(pgType)}) ` : ""}${ident(cname)}: ${tsp};`;
    });
    emit(path, `${decs.join("\n")}\nmodel ${ident(vname)} {\n${props.join("\n")}\n}`);
    bodies.set(`${domain}/views/${vname}.sql`, v.def + "\n");
  }

  // ── cron ────────────────────────────────────────────────────────────
  for (const [jname, j] of Object.entries(ir.cron ?? {})) {
    const path = `${cronOwner(jname)}/cron.tsp`;
    header(path, "cron");
    emit(path, `@schedule(${str(j.schedule)})\n@command(${sqlArg(j.command, 0)})\nop ${ident(jname)}(): void;`);
  }

  // ── common: external containers + auto scalars ──────────────────────
  files.set("common/external.tsp", [
    "// Tables another system owns; the spec owns only what it attaches to them.",
    "namespace storage {\n  @external model objects {}\n}",
    "namespace realtime {\n  @external model messages {}\n}",
  ]);
  if (unknowns.size) {
    files.set("common/types_extra.tsp", [
      "// Auto-declared scalars for Postgres types outside the core map.",
      "namespace `public`;",
      ...[...unknowns].sort().map((u) => `scalar ${u};`),
    ]);
  }

  // ── write files + main.tsp ──────────────────────────────────────────
  const paths = [...files.keys()].sort();
  for (const p of paths) {
    const full = join(outDir, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, files.get(p).join("\n\n") + "\n");
  }
  for (const [p, text] of bodies) {
    const full = join(outDir, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  writeFileSync(join(outDir, "main.tsp"), [
    `import "../../lib/main.tsp";`,
    ...paths.map((p) => `import "./${p}";`),
  ].join("\n") + "\n");

  return { files: paths.length + 1, bodies: bodies.size, notes };
}

function formatGrants(grants) {
  const table = {};   // role -> [privs]
  const col = {};     // role|priv -> [cols]
  for (const g of grants) {
    const m = g.match(/^([^:]+):([A-Z ]+)(?:\(([^)]+)\))?$/);
    if (!m) continue;
    if (m[3]) (col[`${m[1]}|${m[2]}`] ??= []).push(m[3]);
    else (table[m[1]] ??= []).push(m[2].toLowerCase());
  }
  return [
    ...Object.entries(table).map(([role, privs]) => `@grant(${str(role)}, ${str(privs.join(", "))})`),
    ...Object.entries(col).map(([key, cols]) => {
      const [role, priv] = key.split("|");
      return `@grant(${str(role)}, ${str(`${priv.toLowerCase()} (${cols.join(", ")})`)})`;
    }),
  ];
}

function policyTail(p) {
  const parts = [];
  const restrict = p.permissive === "RESTRICTIVE" ? "as restrictive " : "";
  const roles = p.roles.length === 1 && p.roles[0] === "public" ? "" : ` to ${p.roles.join(", ")}`;
  parts.push(`${restrict}for ${p.cmd.toLowerCase()}${roles}`);
  if (p.qual != null) parts.push(`using (${p.qual.trim()})`);
  if (p.with_check != null) parts.push(`with check (${p.with_check.trim()})`);
  return parts.join("\n");
}
