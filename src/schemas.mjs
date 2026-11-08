// Which spec namespaces are Postgres schemas the spec owns, and how an
// object is keyed in the catalog IR. `public` is always one. Any other
// top-level namespace is one when it owns something the emitter creates: a
// namespace of aliases, or of tables another system owns, is not.
import { modelState, opState } from "../lib/index.js";

/** An identifier Postgres takes unquoted. */
export const IDENTIFIER = "[a-z_][a-z0-9_]*";
export const PLAIN_IDENTIFIER = new RegExp(`^${IDENTIFIER}$`);

/**
 * Refuses a name that needs quoting: schema and role names are interpolated
 * into DDL and catalog queries. `kind` names them in the error.
 */
export function assertPlain(kind, names, pattern = PLAIN_IDENTIFIER) {
  const odd = names.filter((name) => !pattern.test(name));
  if (odd.length) throw new Error(`a ${kind} must be a plain identifier: ${odd.map((n) => JSON.stringify(n)).join(", ")}`);
}

// What a namespace holds that the emitter creates: a table or view of its own,
// an enum, a function.
const ownedNames = (ns) => [
  ...[...ns.models.values()].filter((model) => !modelState(model).external).map((model) => model.name),
  ...ns.enums.keys(),
  ...[...ns.operations.values()].filter((op) => opState(op).fn).map((op) => op.name),
];

/**
 * The schemas a compiled spec declares, `public` first. Refuses an object in
 * one of `platform.schemas`, and in `public` unless the spec's data lives there.
 */
export function declaredSchemas(globalNamespace, platform) {
  // the compiler's own namespace is never the spec's
  const topLevel = [...globalNamespace.namespaces].filter(([name]) => name !== "TypeSpec");
  if (!topLevel.some(([name]) => name === "public")) throw new Error("no `public` namespace in spec");

  // Postgres schemas do not nest and nothing reads a nested namespace, so its
  // declarations would compile, lint and never be emitted.
  for (const [name, ns] of topLevel) {
    const [inner] = ns.namespaces.keys();
    if (inner) throw new Error(`namespace ${name}.${inner} is nested: a schema is a top-level namespace`);
  }

  // pg_cron's job list is not a schema: a function declared there lands in `public`
  const owners = topLevel
    .filter(([name, ns]) => name !== "public" && name !== "cron" && ownedNames(ns).length)
    .map(([name]) => name);
  const owned = owners.filter((name) => platform.schemas.includes(name));
  if (owned.length) {
    throw new Error(`${owned.join(", ")} is a platform schema the spec cannot own objects in: mark its tables @external`);
  }
  assertPlain("schema name", owners);

  // Where the spec's data lives beside `public`, nothing lands there: neither
  // what `public` declares nor a function in pg_cron's job list.
  if (!platform.dataInPublic) {
    const inPublic = ["public", "cron"].flatMap((name) => {
      const ns = globalNamespace.namespaces.get(name);
      return ns ? ownedNames(ns) : [];
    });
    if (inPublic.length) {
      throw new Error(
        `public cannot hold ${inPublic.join(", ")}: the platform keeps it empty, closed to every role but the ` +
        `database's owner, so give each a schema of its own`,
      );
    }
  }
  return ["public", ...owners];
}

/** An object's IR key: bare inside `public`, `schema.name` everywhere else. */
export const catalogKey = (schema, name) => (schema === "public" ? name : `${schema}.${name}`);

/** `catalogKey` as SQL, for a query that joins pg_namespace as `n`. */
export const catalogKeySql = (name) =>
  `CASE WHEN n.nspname = 'public' THEN ${name} ELSE n.nspname || '.' || ${name} END`;

// A plain identifier, or two of them as schema.name.
const PLAIN_NAME = new RegExp(`^(?:${IDENTIFIER}\\.)?${IDENTIFIER}$`);

/** Names as a SQL text array literal, for `= ANY(...)`: plain identifiers, or `schema.name` pairs of them. */
export function nameArraySql(names) {
  assertPlain("name in a catalog query", names, PLAIN_NAME);
  return `'{${names.join(",")}}'`;
}
