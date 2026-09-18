// Which spec namespaces are Postgres schemas the spec owns, and how an
// object is keyed in the catalog IR. `public` is always one. Any other
// top-level namespace is one when it owns something the emitter creates: a
// namespace of aliases, or of tables another system owns, is not.
import { modelState, opState } from "../lib/index.js";
import { PLATFORM_SCHEMAS } from "./prelude.mjs";

/** The roles PostgREST serves requests as: the ones whose privileges the check compares. */
export const MANAGED_ROLES = ["anon", "authenticated", "service_role"];

/** An identifier Postgres takes unquoted. */
export const IDENTIFIER = "[a-z_][a-z0-9_]*";
export const PLAIN_IDENTIFIER = new RegExp(`^${IDENTIFIER}$`);

// Schema names are interpolated into catalog queries, so nothing that needs
// quoting is accepted.
function assertPlain(names) {
  const odd = names.filter((name) => !PLAIN_IDENTIFIER.test(name));
  if (odd.length) throw new Error(`a schema name must be a plain identifier: ${odd.join(", ")}`);
}

const owns = (ns) =>
  [...ns.models.values()].some((model) => !modelState(model).external) ||
  ns.enums.size > 0 ||
  [...ns.operations.values()].some((op) => opState(op).fn);

/** The schemas a compiled spec declares, `public` first. */
export function declaredSchemas(globalNamespace) {
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
    .filter(([name, ns]) => name !== "public" && name !== "cron" && owns(ns))
    .map(([name]) => name);
  const platform = owners.filter((name) => PLATFORM_SCHEMAS.includes(name));
  if (platform.length) {
    throw new Error(`${platform.join(", ")} is a platform schema the spec cannot own objects in: mark its tables @external`);
  }
  assertPlain(owners);
  return ["public", ...owners];
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
