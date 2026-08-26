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

const USERS_IMPL = `// ── impl ──────────────────────────────────────────────
@@index(users, "users_email_idx on (email)");
@@trigger(users, "users_touch", "before update for each row", touch_updated_at);
@@doc(users, "foreign decorators are exempt from the layer rules");
`;

const CRON = `namespace cron;
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

describe("layer ordering lint", () => {
  test("colocated_ledger_lints_clean", async () => {
    const violations = await lintSpec({
      "identity/users.tsp": USERS + "\n" + USERS_IMPL,
      "identity/cron.tsp": CRON,
    });
    expect(violations).toEqual([]);
  });

  test("pure_impl_overflow_file_lints_clean", async () => {
    const violations = await lintSpec({
      "identity/users.tsp": USERS,
      "identity/users.ledger.tsp": `namespace \`public\`;\n${USERS_IMPL}`,
    });
    expect(violations).toEqual([]);
  });

  test("impl_before_contract_flags", async () => {
    const violations = await lintSpec({
      "identity/users.tsp":
        `namespace \`public\`;\n@@index(users, "users_email_idx on (email)");\n` + USERS.replace("namespace `public`;\n", ""),
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("impl");
    expect(violations[0].file.endsWith("users.tsp")).toBe(true);
    expect(violations[0].line).toBeGreaterThan(0);
  });

  test("contract_after_impl_flags", async () => {
    const violations = await lintSpec({
      "identity/users.tsp": USERS + "\n" + USERS_IMPL + `@@grant(users, "anon", "select");\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("contract");
  });

  test("inline_impl_decorator_must_be_augment", async () => {
    const violations = await lintSpec({
      "identity/runs.tsp": `namespace \`public\`;\n@partition_by("range (started_at)")\nmodel runs { id: uuid; started_at: timestamptz; }\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("augment");
  });

  test("contract_declaration_after_cron_op_flags", async () => {
    const violations = await lintSpec({
      "identity/mixed.tsp": CRON + `\nmodel stray { id: string; }\n`,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("contract");
  });
});
