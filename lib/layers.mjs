// The contract/impl partition. Impl is enumerated; everything else is
// contract. Fail-closed: an unlisted decorator gates hard and must live
// in contract files until deliberately demoted to this set.
export const IMPL_DECORATORS = new Set([
  "index", "trigger", "schedule", "command", "partition_by",
]);

export const decoratorLayer = (name) => (IMPL_DECORATORS.has(name) ? "impl" : "contract");
