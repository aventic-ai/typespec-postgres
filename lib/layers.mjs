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
