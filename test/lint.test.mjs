import { describe, test, expect } from "bun:test";
import { lintSpec } from "./harness.mjs";
import { decoratorLayer, sectionRank } from "../lib/layers.mjs";

const USERS = `namespace \`public\`;
@pk("id")
model users {
  @default("gen_random_uuid()") id: uuid;
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
      "kbyg/views.tsp": `namespace \`public\`;\n@security_invoker @view model v { id: uuid; }\n\n@@grant(v, "authenticated", "select");\n`,
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
