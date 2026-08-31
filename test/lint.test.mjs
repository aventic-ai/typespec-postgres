import { describe, test, expect } from "bun:test";
import { lintSpec } from "./harness.mjs";
import {
  decoratorLayer, sectionRank, factRank,
  FACT_ORDER, IMPL_DECORATORS, SECURITY_DECORATORS,
} from "../lib/layers.mjs";
import { $decorators } from "../lib/index.js";

const USERS = `namespace \`public\`;
@pk("id")
model users {
  id: uuid = sql.of("gen_random_uuid()");
  email?: text;
}
@function("plpgsql") op touch_updated_at(): trigger;

// ── security ──────────────────────────────────────────
@@rls(users);
@@grant(users, "authenticated", "select");
@@policy(users, "self read", "for select to authenticated using (id = auth.uid())");

// ── impl ──────────────────────────────────────────────
@@index(users, "users_email_idx on (email)");
@@trigger(users, "users_touch", "before update for each row", touch_updated_at);
@@doc(users, "foreign decorators are exempt from the layer rules");
`;

const CRON = `namespace cron;
@schedule("17 3 * * *")
@command("select 1")
op nightly_probe(): void;
`;

describe("sections and layers", () => {
  test("unlisted_decorator_defaults_data_and_contract", () => {
    expect(decoratorLayer("brand_new_decorator")).toBe("contract");
    expect(sectionRank("brand_new_decorator")).toBe(0);
    expect(sectionRank("grant")).toBe(1);
    expect(sectionRank("trigger")).toBe(2);
  });
});

describe("section ordering lint", () => {
  test("sectioned_spec_lints_clean", async () => {
    const violations = await lintSpec({
      "identity/users.tsp": USERS,
      "identity/cron.tsp": CRON,
    });
    expect(violations).toEqual([]);
  });

  test("inline_rls_on_header_flags", async () => {
    const violations = await lintSpec({
      "identity/users.tsp": `namespace \`public\`;\n@rls model plain { id: uuid; }\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("augment");
  });

  test("inline_grant_on_op_flags", async () => {
    const violations = await lintSpec({
      "identity/fns.tsp": `namespace \`public\`;\n@grant("authenticated", "execute") @function("sql stable") op f(): text;\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("augment");
  });

  test("security_after_impl_flags", async () => {
    const violations = await lintSpec({
      "identity/users.tsp": USERS + `@@grant(users, "anon", "select");\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("security");
  });

  test("data_after_security_flags", async () => {
    const violations = await lintSpec({
      "identity/pair.tsp": `namespace \`public\`;\nmodel a { id: uuid; }\n@@rls(a);\nmodel b { id: uuid; }\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("data");
  });

  test("view_security_flags_inline_ok", async () => {
    const violations = await lintSpec({
      "kbyg/views.tsp": `namespace \`public\`;\n@security_invoker\n@view\nmodel v { id: uuid; }\n\n@@grant(v, "authenticated", "select");\n`,
    });
    expect(violations).toEqual([]);
  });

  test("contract_declaration_after_cron_op_flags", async () => {
    const violations = await lintSpec({
      "identity/mixed.tsp": CRON + `\nmodel stray { id: string; }\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("data");
  });
});

describe("model decorator formatting", () => {
  test("decorator_on_model_line_flags", async () => {
    const violations = await lintSpec({
      "identity/one.tsp": `namespace \`public\`;\n@pk("id") model one { id: uuid; }\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("own line");
  });

  test("decorators_sharing_a_line_flags", async () => {
    const violations = await lintSpec({
      "identity/two.tsp": `namespace \`public\`;\n@pk("id") @constraint("two_ck", "CHECK (true)")\nmodel two { id: uuid; }\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("own line");
  });

  test("stacked_own_line_decorators_clean", async () => {
    const violations = await lintSpec({
      "identity/three.tsp": `namespace \`public\`;\n@pk("id")\n@constraint("three_ck", "CHECK (true)")\nmodel three { id: uuid; }\n`,
    });
    expect(violations).toEqual([]);
  });

  test("property_decorator_on_property_line_flags", async () => {
    const violations = await lintSpec({
      "identity/four.tsp": `namespace \`public\`;\nmodel a { id: uuid; }\nmodel b {\n  @references(a.id) a_id: uuid;\n}\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("own line");
  });

  test("stacked_property_decorator_clean", async () => {
    const violations = await lintSpec({
      "identity/five.tsp": `namespace \`public\`;\nmodel a { id: uuid; }\nmodel b {\n  @references(a.id)\n  a_id: uuid;\n}\n`,
    });
    expect(violations).toEqual([]);
  });
});

describe("decorator order on a declaration", () => {
  // The order is only predictable if it is total: a decorator that can be
  // written on a declaration and has no position would silently escape it.
  test("fact_order_covers_every_declaration_decorator", () => {
    const inlineOk = new Set(["security_invoker", "security_definer", "schedule", "command"]);
    const inline = Object.keys($decorators[""]).filter(
      (n) => inlineOk.has(n) || (!IMPL_DECORATORS.has(n) && !SECURITY_DECORATORS.has(n)),
    );
    expect(inline.filter((n) => factRank(n) === null)).toEqual([]);
    expect(FACT_ORDER.filter((n) => !inline.includes(n))).toEqual([]);
    expect(new Set(FACT_ORDER).size).toBe(FACT_ORDER.length);
  });

  test("canonical_table_header_clean", async () => {
    const violations = await lintSpec({
      "events/e.tsp": `namespace \`public\`;
@pk("id")
@check("(a > 0)")
@check("(a < 9)")
@constraint("e_uq", "UNIQUE (a)")
@constraint("e_fk", "FOREIGN KEY (a) REFERENCES t(a)")
model e {
  id: uuid;
  a: integer;
}
model t {
  a: integer;
}
`,
    });
    expect(violations).toEqual([]);
  });

  test("check_before_pk_flags", async () => {
    const violations = await lintSpec({
      "events/e.tsp": `namespace \`public\`;\n@check("(a > 0)")\n@pk("id")\nmodel e {\n  id: uuid;\n  a: integer;\n}\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("@pk on model e belongs above @check");
  });

  test("constraint_before_check_flags", async () => {
    const violations = await lintSpec({
      "events/e.tsp": `namespace \`public\`;\n@pk("id")\n@constraint("e_uq", "UNIQUE (a)")\n@check("(a > 0)")\nmodel e {\n  id: uuid;\n  a: integer;\n}\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("@check on model e belongs above @constraint");
  });

  test("repeated_decorators_keep_author_order", async () => {
    const violations = await lintSpec({
      "events/e.tsp": `namespace \`public\`;\n@check("(z > 0)")\n@check("(a > 0)")\nmodel e {\n  a: integer;\n  z: integer;\n}\n`,
    });
    expect(violations).toEqual([]);
  });

  test("foreign_decorator_between_facts_is_exempt", async () => {
    const violations = await lintSpec({
      "events/e.tsp": `namespace \`public\`;\n@pk("id")\n@doc("still in order")\n@check("(a > 0)")\nmodel e {\n  id: uuid;\n  a: integer;\n}\n`,
    });
    expect(violations).toEqual([]);
  });

  test("view_flag_before_view_clean_and_reverse_flags", async () => {
    const clean = await lintSpec({
      "kbyg/v.tsp": `namespace \`public\`;\n@security_invoker\n@view\nmodel v { id: uuid; }\n`,
    });
    expect(clean).toEqual([]);
    const violations = await lintSpec({
      "kbyg/v.tsp": `namespace \`public\`;\n@view\n@security_invoker\nmodel v { id: uuid; }\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("@security_invoker on model v belongs above @view");
  });

  test("pg_name_before_function_clean_and_reverse_flags", async () => {
    const clean = await lintSpec({
      "platform/f.tsp": `namespace \`public\`;\n@pg_name("f")\n@function("sql stable")\nop f__overload2(): text;\n`,
    });
    expect(clean).toEqual([]);
    const violations = await lintSpec({
      "platform/f.tsp": `namespace \`public\`;\n@function("sql stable")\n@pg_name("f")\nop f__overload2(): text;\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("@pg_name on op f__overload2 belongs above @function");
  });

  test("cron_command_before_schedule_flags", async () => {
    const violations = await lintSpec({
      "identity/cron.tsp": `namespace cron;\n@command("select 1")\n@schedule("17 3 * * *")\nop nightly(): void;\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("@schedule on op nightly belongs above @command");
  });

  test("property_fact_order_flags", async () => {
    const violations = await lintSpec({
      "events/e.tsp": `namespace \`public\`;\nmodel t {\n  a: integer;\n}\nmodel e {\n  @check("(a > 0)")\n  @references(t.a)\n  a: integer;\n}\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("@references on e.a belongs above @check");
  });

  test("misordered_decorators_flag_once_per_model", async () => {
    const violations = await lintSpec({
      "events/e.tsp": `namespace \`public\`;\n@check("(a > 0)")\n@pk("id")\nmodel e {\n  id: uuid;\n  @check("(a > 0)")\n  @pg_type("int4")\n  a: integer;\n}\n`,
    });
    expect(violations.length).toBe(1);
  });

  test("augment_required_decorator_is_not_also_misordered", async () => {
    const violations = await lintSpec({
      "identity/u.tsp": `namespace \`public\`;\n@rls\n@pk("id")\nmodel u { id: uuid; }\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("augment");
  });
});
