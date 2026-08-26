// @aventic/pgspec decorator implementations. Mechanical by design: each
// decorator stores its verbatim arguments against the decorated type; the
// emitter walks the program and reads this state. No SQL parsing here — the
// shadow database is the SQL parser.

const state = () =>
  (globalThis.__pgspec ??= {
    // Type object → facts. WeakMap keyed on the compiler's Type identity.
    model: new WeakMap(),
    op: new WeakMap(),
    prop: new WeakMap(),
  });

const bucket = (map, target) => {
  let b = map.get(target);
  if (!b) map.set(target, (b = {}));
  return b;
};

const set = (kind, key) => (ctx, target, ...args) => {
  bucket(state()[kind], target)[key] = args.length > 1 ? args : (args[0] ?? true);
};
const push = (kind, key) => (ctx, target, ...args) => {
  const b = bucket(state()[kind], target);
  (b[key] ??= []).push(args);
};

const impls = {
  rls: set("model", "rls"),
  external: set("model", "external"),
  pk: (ctx, t, cols, name) => (bucket(state().model, t).pk = { cols, name }),
  partition_by: set("model", "partition_by"),
  unmanaged_partitions: set("model", "unmanaged_partitions"),
  check: (ctx, t, expr, name) => {
    const kind = t.kind === "ModelProperty" ? "prop" : "model";
    (bucket(state()[kind], t).checks ??= []).push({ expr, name });
  },
  constraint: (ctx, t, name, def) => {
    (bucket(state().model, t).constraints ??= []).push({ name, def });
  },
  default: set("prop", "default"),
  identity: set("prop", "identity"),
  pg_type: set("prop", "pg_type"),
  generated: set("prop", "generated"),
  arg_default: set("prop", "arg_default"),
  references: (ctx, t, ref, actions, name) => {
    bucket(state().prop, t).references = { ref, actions, name };
  },
  grant: (ctx, t, role, privileges) => {
    const kind = t.kind === "Operation" ? "op" : "model";
    (bucket(state()[kind], t).grants ??= []).push({ role, privileges });
  },
  index: (ctx, t, tail) => (bucket(state().model, t).indexes ??= []).push(tail),
  policy: (ctx, t, name, tail) => (bucket(state().model, t).policies ??= []).push({ name, tail }),
  trigger: (ctx, t, name, fires, execute) =>
    (bucket(state().model, t).triggers ??= []).push({ name, fires, execute }),
  view: (ctx, t, body) => (bucket(state().model, t).view = { body: body ?? null }),
  security_invoker: set("model", "security_invoker"),
  security_definer: set("model", "security_definer"),
  function: (ctx, t, options, body) => (bucket(state().op, t).fn = { options, body: body ?? null }),
  pg_name: set("op", "pg_name"),
  schedule: set("op", "schedule"),
  command: set("op", "command"),
};

export const $decorators = { "": impls };

/** Emitter-side accessors. */
export const pgState = () => state();
export const modelState = (t) => state().model.get(t) ?? {};
export const opState = (t) => state().op.get(t) ?? {};
export const propState = (t) => state().prop.get(t) ?? {};
