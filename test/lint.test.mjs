import { describe, test, expect } from "bun:test";
import { lintSpec } from "./harness.mjs";
import { decoratorLayer } from "../lib/layers.mjs";

const USERS = `namespace \`public\`;
@rls
@pk("id")
@grant("authenticated", "select")
model users {
  @default("gen_random_uuid()") id: uuid;
  email?: text;
}
@@policy(users, "self read", "for select to authenticated using (id = auth.uid())");
@function("plpgsql") op touch_updated_at(): trigger;
`;

const USERS_IMPL = `namespace \`public\`;
@@index(users, "users_email_idx on (email)");
@@trigger(users, "users_touch", "before update for each row", touch_updated_at);
@@doc(users, "foreign decorators are exempt from the layer rule");
`;

const CRON_IMPL = `namespace cron;
@schedule("17 3 * * *")
@command("select 1")
op nightly_probe(): void;
`;

describe("layer partition", () => {
  test("unlisted_decorator_fails_closed_to_contract", () => {
    expect(decoratorLayer("brand_new_decorator")).toBe("contract");
    expect(decoratorLayer("trigger")).toBe("impl");
  });
});

describe("layering lint", () => {
  test("layered_spec_lints_clean", async () => {
    const violations = await lintSpec({
      "identity/users.tsp": USERS,
      "identity/users.impl.tsp": USERS_IMPL,
      "identity/cron.impl.tsp": CRON_IMPL,
    });
    expect(violations).toEqual([]);
  });

  test("impl_decorator_in_contract_file_flags", async () => {
    const violations = await lintSpec({
      "identity/users.tsp": USERS + `@@index(users, "users_email_idx on (email)");\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("@index");
    expect(violations[0].file.endsWith("users.tsp")).toBe(true);
    expect(violations[0].line).toBeGreaterThan(0);
  });

  test("contract_augment_in_impl_file_flags", async () => {
    const violations = await lintSpec({
      "identity/users.tsp": USERS,
      "identity/users.impl.tsp": USERS_IMPL + `@@grant(users, "anon", "select");\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("@grant");
    expect(violations[0].file.endsWith("users.impl.tsp")).toBe(true);
  });

  test("model_declared_in_impl_file_flags", async () => {
    const violations = await lintSpec({
      "identity/stray.impl.tsp": `namespace \`public\`;\nmodel stray { id: uuid; }\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("stray");
    expect(violations[0].file.endsWith("stray.impl.tsp")).toBe(true);
  });

  test("op_declared_in_impl_file_flags", async () => {
    const violations = await lintSpec({
      "identity/fns.impl.tsp": `namespace \`public\`;\n@function("sql stable") op stray_fn(): text;\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("stray_fn");
  });

  test("cron_op_in_contract_file_flags", async () => {
    const violations = await lintSpec({
      "identity/cron.tsp": CRON_IMPL,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("nightly_probe");
    expect(violations[0].file.endsWith("cron.tsp")).toBe(true);
  });
});
