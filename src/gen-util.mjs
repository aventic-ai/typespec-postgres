// Shared text-generation helpers: TypeSpec identifier escaping, string
// escaping, SQL-block formatting, type mapping.

const KEYWORDS = new Set([
  "import", "model", "op", "namespace", "interface", "union", "enum", "scalar",
  "alias", "using", "is", "extends", "valueof", "extern", "dec", "fn", "const",
  "init", "projection", "if", "else", "record", "never", "unknown", "void",
  "null", "true", "false", "return", "statemachine", "macro", "package",
  "metadata", "env", "arg", "declare", "context", "mod", "pub", "sub",
  "typeref", "trait", "this", "self", "super", "keyof", "with", "implements",
  "impl", "satisfies", "flag", "auto", "partial", "private", "public",
  "protected", "internal", "sealed", "local", "async", "external",
]);

export const ident = (name) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !KEYWORDS.has(name) ? name : `\`${name}\``;

/** Escape for a single-line "..." TypeSpec string. */
export const str = (s) =>
  `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("${", "\\${").replaceAll("\n", "\\n")}"`;

/** Format text as a triple-quoted block at the given indent. */
export function block(text, indent) {
  const esc = text.replaceAll("\\", "\\\\").replaceAll("${", "\\${");
  if (esc.includes('"""')) throw new Error(`SQL contains """ — needs manual escaping: ${esc.slice(0, 80)}`);
  const margin = " ".repeat(indent);
  const inner = " ".repeat(indent + 2);
  const lines = esc.split("\n").map((l) => (l.trim() ? inner + l : ""));
  return `"""\n${lines.join("\n")}\n${inner}"""`;
}

/** One string arg: single-line if short and newline-free, else a block. */
export const sqlArg = (s, indent) =>
  !s.includes("\n") && s.length <= 90 ? str(s) : block(s, indent);

const TYPE_MAP = {
  text: "text", uuid: "uuid", "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp", integer: "integer", jsonb: "jsonb",
  json: "json", boolean: "boolean", bigint: "bigint", smallint: "smallint",
  numeric: "numeric", date: "date", bytea: "bytea", "double precision": "float8",
  inet: "inet", trigger: "trigger", void: "void",
};

/**
 * Map a Postgres type to a TypeSpec type reference.
 * Returns { tsp, pgType } — pgType set when the spelling carries a typmod
 * (numeric(5,4)) that the scalar alone loses, to be emitted as @pg_type.
 * `unknowns` collects types needing auto-declared scalars.
 */
export function mapType(pg, { enums = {}, tables = {}, unknowns = new Set() } = {}) {
  if (pg.endsWith("[]")) {
    const inner = mapType(pg.slice(0, -2), { enums, tables, unknowns });
    return { tsp: `${inner.tsp}[]`, pgType: inner.pgType ? pg : undefined };
  }
  if (TYPE_MAP[pg]) return { tsp: TYPE_MAP[pg] };
  if (enums[pg]) return { tsp: ident(pg) };
  if (tables[pg]) return { tsp: ident(pg) };
  const m = pg.match(/^([a-z_ ]+)\((.+)\)$/);
  if (m) {
    const base = mapType(m[1].trim(), { enums, tables, unknowns });
    return { tsp: base.tsp, pgType: pg };
  }
  const scalarName = pg.replaceAll(/[^A-Za-z0-9_]/g, "_");
  unknowns.add(scalarName);
  return { tsp: scalarName, pgType: pg === scalarName ? undefined : pg };
}
