import { describe, test, expect } from "bun:test";
import { diff, report } from "../src/differ.mjs";

// diff() is pure: fixtures are plain IR objects, no database.
const ir = (over = {}) => ({
  enums: {}, tables: {}, policies: {}, triggers: {}, functions: {}, views: {}, cron: {},
  ...over,
});
const table = (over = {}) => ({
  partitioned: false, partkey: null, rls: true, grants: ["authenticated:SELECT"],
  columns: [{ name: "id", type: "uuid", notnull: true, default: null, generated: false, identity: "" }],
  constraints: {}, indexes: {},
  ...over,
});
const fn = (over = {}) => ({
  args: "", returns: "void", language: "plpgsql", volatility: "v", strict: false,
  security_definer: false, config: null, body: "begin end", public_execute: false, grants: [],
  ...over,
});
const view = (over = {}) => ({
  def: "select 1", security_invoker: true, columns: [["x", "integer"]], grants: [],
  ...over,
});

const one = (problems) => {
  expect(problems.length).toBe(1);
  return problems[0];
};

describe("differ layer tagging", () => {
  test("identical_irs_diff_clean", () => {
    const a = ir({ tables: { users: table() }, functions: { "f()": fn() } });
    expect(diff(a, a)).toEqual([]);
  });

  test("column_type_drift_is_contract", () => {
    const p = one(diff(
      ir({ tables: { users: table() } }),
      ir({ tables: { users: table({ columns: [{ name: "id", type: "text", notnull: true, default: null, generated: false, identity: "" }] }) } }),
    ));
    expect(p.layer).toBe("contract");
    expect(p.kind).toBe("column users");
  });

  test("grants_drift_is_contract", () => {
    const p = one(diff(
      ir({ tables: { users: table() } }),
      ir({ tables: { users: table({ grants: ["anon:UPDATE"] }) } }),
    ));
    expect(p.layer).toBe("contract");
  });

  test("rls_drift_is_contract", () => {
    const p = one(diff(
      ir({ tables: { users: table() } }),
      ir({ tables: { users: table({ rls: false }) } }),
    ));
    expect(p.layer).toBe("contract");
  });

  test("constraint_drift_is_contract", () => {
    const p = one(diff(
      ir({ tables: { users: table({ constraints: { users_pkey: { type: "p", def: "PRIMARY KEY (id)" } } }) } }),
      ir({ tables: { users: table() } }),
    ));
    expect(p.layer).toBe("contract");
    expect(p.kind).toBe("constraint users");
  });

  test("missing_table_is_contract", () => {
    const p = one(diff(ir(), ir({ tables: { users: table() } })));
    expect(p.layer).toBe("contract");
    expect(p.what).toContain("missing in spec");
  });

  test("policy_drift_is_contract", () => {
    const p = one(diff(
      ir({ policies: { "public.users:self": { permissive: "PERMISSIVE", cmd: "SELECT", roles: ["authenticated"], qual: "id = auth.uid()", with_check: null } } }),
      ir(),
    ));
    expect(p.layer).toBe("contract");
  });

  test("enum_drift_is_contract", () => {
    const p = one(diff(
      ir({ enums: { mood: ["happy"] } }),
      ir({ enums: { mood: ["happy", "sad"] } }),
    ));
    expect(p.layer).toBe("contract");
  });

  test("function_volatility_drift_is_contract", () => {
    const p = one(diff(
      ir({ functions: { "f()": fn() } }),
      ir({ functions: { "f()": fn({ volatility: "s" }) } }),
    ));
    expect(p.layer).toBe("contract");
  });

  test("view_projection_drift_is_contract", () => {
    const p = one(diff(
      ir({ views: { v: view() } }),
      ir({ views: { v: view({ columns: [["x", "text"]] }) } }),
    ));
    expect(p.layer).toBe("contract");
  });

  test("index_drift_is_impl", () => {
    const p = one(diff(
      ir({ tables: { users: table({ indexes: { users_idx: "CREATE INDEX users_idx ON public.users (id)" } }) } }),
      ir({ tables: { users: table() } }),
    ));
    expect(p.layer).toBe("impl");
    expect(p.kind).toBe("index users");
  });

  test("trigger_missing_is_impl", () => {
    const p = one(diff(
      ir(),
      ir({ triggers: { "users:touch": "CREATE TRIGGER touch ..." } }),
    ));
    expect(p.layer).toBe("impl");
  });

  test("cron_drift_is_impl", () => {
    const p = one(diff(
      ir({ cron: { nightly: { schedule: "0 3 * * *", command: "select 1" } } }),
      ir({ cron: { nightly: { schedule: "0 4 * * *", command: "select 1" } } }),
    ));
    expect(p.layer).toBe("impl");
  });

  test("partitioning_drift_is_impl", () => {
    const problems = diff(
      ir({ tables: { runs: table() } }),
      ir({ tables: { runs: table({ partitioned: true, partkey: "RANGE (started_at)" }) } }),
    );
    expect(problems.length).toBe(2);
    for (const p of problems) expect(p.layer).toBe("impl");
  });

  test("function_body_drift_is_impl", () => {
    const p = one(diff(
      ir({ functions: { "f()": fn() } }),
      ir({ functions: { "f()": fn({ body: "begin null; end" }) } }),
    ));
    expect(p.layer).toBe("impl");
  });

  test("view_definition_drift_is_impl", () => {
    const p = one(diff(
      ir({ views: { v: view() } }),
      ir({ views: { v: view({ def: "select 2" }) } }),
    ));
    expect(p.layer).toBe("impl");
  });
});

describe("severity report", () => {
  test("clean_reports_zero_differences", () => {
    expect(report([])).toContain("0 differences");
  });

  test("contract_section_precedes_impl", () => {
    const problems = diff(
      ir({ tables: { users: table() } }),
      ir({
        tables: { users: table({ rls: false, indexes: { i: "CREATE INDEX i ON public.users (id)" } }) },
      }),
    );
    const text = report(problems);
    const contractAt = text.indexOf("contract");
    const implAt = text.indexOf("impl");
    expect(contractAt).toBeGreaterThan(-1);
    expect(implAt).toBeGreaterThan(contractAt);
  });
});
