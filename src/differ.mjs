// IR differ: two catalogs in, list of problems out. Closed-world: an object
// present on either side but not the other is drift — in BOTH layers; the
// layer tag decides disposition (gate vs mirror), never detection.
// Impl facts are enumerated; everything else fails closed to contract, so a
// facet added later gates by default (same rule as lib/layers.mjs).
const IMPL_KIND = (kind) => kind === "trigger" || kind === "cron" || kind.startsWith("index ");
const IMPL_FACET = new Set(["table:partitioned", "table:partition key", "function:body", "view:definition"]);
const layerOf = (kind, name) =>
  IMPL_KIND(kind) || IMPL_FACET.has(`${kind}:${name}`) ? "impl" : "contract";

function diffMaps(kind, spec, live, problems, compare) {
  const keys = [...new Set([...Object.keys(spec ?? {}), ...Object.keys(live ?? {})])].sort();
  for (const k of keys) {
    const s = spec?.[k], l = live?.[k];
    if (s === undefined) problems.push({ layer: layerOf(kind), kind, key: k, what: "missing in spec (exists in database)" });
    else if (l === undefined) problems.push({ layer: layerOf(kind), kind, key: k, what: "missing in database (spec expects it)" });
    else compare(k, s, l);
  }
}

const jstr = (v) => JSON.stringify(v);

export function diff(spec, live) {
  const problems = [];
  const facet = (kind, key, name, s, l) => {
    if (jstr(s) !== jstr(l)) problems.push({ layer: layerOf(kind, name), kind, key, what: `${name} differs`, spec: s, live: l });
  };

  diffMaps("enum", spec.enums, live.enums, problems, (k, s, l) => facet("enum", k, "labels", s, l));

  diffMaps("table", spec.tables, live.tables, problems, (k, s, l) => {
    facet("table", k, "partitioned", s.partitioned, l.partitioned);
    facet("table", k, "partition key", s.partkey, l.partkey);
    facet("table", k, "rls", s.rls, l.rls);
    facet("table", k, "grants", s.grants, l.grants);
    const sc = Object.fromEntries(s.columns.map((c) => [c.name, c]));
    const lc = Object.fromEntries(l.columns.map((c) => [c.name, c]));
    diffMaps(`column ${k}`, sc, lc, problems, (ck, cs, cl) => facet(`column ${k}`, ck, "definition", cs, cl));
    facet("table", k, "column order", s.columns.map((c) => c.name), l.columns.map((c) => c.name));
    diffMaps(`constraint ${k}`, s.constraints, l.constraints, problems, (ck, cs, cl) =>
      facet(`constraint ${k}`, ck, "definition", cs, cl));
    diffMaps(`index ${k}`, s.indexes, l.indexes, problems, (ck, cs, cl) =>
      facet(`index ${k}`, ck, "definition", cs, cl));
  });

  diffMaps("policy", spec.policies, live.policies, problems, (k, s, l) => facet("policy", k, "definition", s, l));
  diffMaps("trigger", spec.triggers, live.triggers, problems, (k, s, l) => facet("trigger", k, "definition", s, l));
  diffMaps("function", spec.functions, live.functions, problems, (k, s, l) => {
    for (const f of ["args", "returns", "language", "volatility", "strict", "security_definer",
                     "config", "public_execute", "grants"]) facet("function", k, f, s[f], l[f]);
    if (s.body !== l.body) problems.push({ layer: layerOf("function", "body"), kind: "function", key: k,
      what: "body differs", spec: s.body.slice(0, 200), live: l.body.slice(0, 200) });
  });
  diffMaps("view", spec.views, live.views, problems, (k, s, l) => {
    facet("view", k, "definition", s.def, l.def);
    facet("view", k, "security_invoker", s.security_invoker, l.security_invoker);
    facet("view", k, "columns", s.columns, l.columns);
    facet("view", k, "grants", s.grants, l.grants);
  });
  diffMaps("cron", spec.cron, live.cron, problems, (k, s, l) => {
    facet("cron", k, "schedule", s.schedule, l.schedule);
    facet("cron", k, "command", s.command?.trim(), l.command?.trim());
  });

  return problems;
}

export function report(problems) {
  if (!problems.length) return "spec/db matches the database. 0 differences.";
  const contract = problems.filter((p) => p.layer === "contract");
  const impl = problems.filter((p) => p.layer === "impl");
  const lines = [`${problems.length} difference(s): ${contract.length} contract (gate), ${impl.length} impl (mirror)`];
  section(lines, "contract drift (gate):", contract);
  section(lines, "impl drift (mirror):", impl);
  return lines.join("\n");
}

function section(lines, title, problems) {
  if (!problems.length) return;
  lines.push(title);
  for (const p of problems.slice(0, 80)) {
    lines.push(`  ${p.kind} ${p.key}: ${p.what}`);
    if (p.spec !== undefined) lines.push(`      spec: ${jstr(p.spec)?.slice(0, 220)}`);
    if (p.live !== undefined) lines.push(`      live: ${jstr(p.live)?.slice(0, 220)}`);
  }
  if (problems.length > 80) lines.push(`  ... and ${problems.length - 80} more`);
}
