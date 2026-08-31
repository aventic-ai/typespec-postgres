// The contract/impl partition. Impl is enumerated; everything else is
// contract. Fail-closed: an unlisted decorator gates hard and must live
// in contract files until deliberately demoted to this set.
export const IMPL_DECORATORS = new Set([
  "index", "trigger", "schedule", "command", "partition_by",
]);

export const decoratorLayer = (name) => (IMPL_DECORATORS.has(name) ? "impl" : "contract");

// File anatomy: three SECTIONS (data < security < impl), orthogonal to the
// two LAYERS above — everything security-rank still gates at contract
// severity. Sections are the author's reading order; layers are the
// checker's disposition.
export const SECURITY_DECORATORS = new Set([
  "rls", "grant", "policy", "security_invoker", "security_definer",
]);

export const sectionRank = (name) =>
  IMPL_DECORATORS.has(name) ? 2 : SECURITY_DECORATORS.has(name) ? 1 : 0;

// Decorator order. A FACT is one decorator written on a declaration —
// goal.md's word for them ("a header stays a scannable list of facts"). Where
// sectionRank orders STATEMENTS across a file, this orders the FACTS on a
// single declaration: kind and identity, then shape, then invariants, then
// verbatim DDL — the same structured-to-raw progression the sections use, one
// altitude down. Short scannable facts sit at the top of a header; multi-line
// SQL blocks sit at the bottom, next to the declaration they describe.
// Repeats of one decorator keep the author's order; foreign decorators are
// exempt. This list must cover every decorator that can legally be written on
// a declaration (test/lint.test.mjs asserts it) — a new one takes its
// position deliberately.
export const FACT_ORDER = [
  // kind and identity — what this declaration is
  "external", "pg_name", "security_invoker", "security_definer",
  "view", "function", "schedule",
  // shape — what it holds and what it points at
  "pg_type", "identity", "pk", "references",
  // invariants
  "check",
  // verbatim DDL — the raw SQL tail
  "generated", "command", "constraint",
];

const FACT_RANK = new Map(FACT_ORDER.map((name, i) => [name, i]));

/** Position in the canonical decorator order; null for names it omits. */
export const factRank = (name) => FACT_RANK.get(name) ?? null;
