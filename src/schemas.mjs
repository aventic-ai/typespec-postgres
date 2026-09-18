// Which spec namespaces are Postgres schemas the spec owns, and how an
// object is keyed in the catalog IR. `public` is always one; any other
// top-level namespace is a schema of its own unless it is reserved below.

// Namespaces that are never the spec's to create: the compiler's own,
// pg_cron's job list, and the platform schemas, which are the ones
// prelude.mjs stands in for. A spec may still hang policies on their tables.
const RESERVED_NAMESPACES = new Set(["TypeSpec", "cron", "extensions", "auth", "storage", "realtime"]);

// Schema names are interpolated into catalog queries, so nothing that needs
// quoting is accepted.
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertPlain(names) {
  const odd = names.filter((name) => !PLAIN_IDENTIFIER.test(name));
  if (odd.length) throw new Error(`a schema name must be a plain identifier: ${odd.join(", ")}`);
}

/** The schemas a compiled spec declares, `public` first. */
export function declaredSchemas(globalNamespace) {
  const names = [...globalNamespace.namespaces.keys()].filter((name) => !RESERVED_NAMESPACES.has(name));
  if (!names.includes("public")) throw new Error("no `public` namespace in spec");
  assertPlain(names);
  return ["public", ...names.filter((name) => name !== "public")];
}

/** An object's IR key: bare inside `public`, `schema.name` everywhere else. */
export const catalogKey = (schema, name) => (schema === "public" ? name : `${schema}.${name}`);

/** `catalogKey` as SQL, for a query that joins pg_namespace as `n`. */
export const catalogKeySql = (name) =>
  `CASE WHEN n.nspname = 'public' THEN ${name} ELSE n.nspname || '.' || ${name} END`;

/** A schema list as a SQL array literal, for `= ANY(...)`. */
export function schemaArraySql(schemas) {
  assertPlain(schemas);
  return `'{${schemas.join(",")}}'`;
}
