import { describe, test, expect } from "bun:test";
import { SUPABASE, plainPostgres, platformNamed } from "../src/platform.mjs";

describe("the platform a check names", () => {
  test("supabase_names_supabase", () => {
    expect(platformNamed("supabase")).toBe(SUPABASE);
  });

  test("supabase_takes_no_roles_of_its_own", () => {
    expect(() => platformNamed("supabase", { owner: "app_owner" })).toThrow(/Supabase's roles are its own/);
    expect(() => platformNamed("supabase", { roles: "app_runtime" })).toThrow(/Supabase's roles are its own/);
  });

  test("postgres_takes_an_owner_and_a_comma_separated_role_list", () => {
    const platform = platformNamed("postgres", { owner: "app_owner", roles: "app_runtime,app_reader" });
    expect(platform).toMatchObject({ owner: "app_owner", roles: ["app_runtime", "app_reader"] });
  });

  test("an_empty_role_in_the_list_is_named_as_empty", () => {
    expect(() => platformNamed("postgres", { owner: "app_owner", roles: "" })).toThrow(/plain identifier: ""/);
  });

  test("an_unknown_platform_is_refused", () => {
    expect(() => platformNamed("aurora")).toThrow(/no platform aurora/);
  });
});

describe("plain Postgres", () => {
  test("needs_the_role_its_migrations_run_as", () => {
    expect(() => plainPostgres({ roles: ["app_runtime"] })).toThrow(/needs an owner/);
  });

  test("needs_a_role_a_grant_can_reach", () => {
    expect(() => plainPostgres({ owner: "app_owner", roles: [] })).toThrow(/roles a grant can reach/);
    expect(() => plainPostgres({ owner: "app_owner" })).toThrow(/roles a grant can reach/);
  });

  // Role names are interpolated into the shadow's DDL and the catalog queries.
  test("a_role_name_must_be_a_plain_identifier", () => {
    expect(() => plainPostgres({ owner: "app_owner", roles: ["x}'; drop role app_owner; --"] })).toThrow(
      /plain identifier.*drop role/,
    );
    expect(() => plainPostgres({ owner: "Owner", roles: ["app_runtime"] })).toThrow(/plain identifier: "Owner"/);
  });

  test("the_owner_is_not_one_of_the_roles_a_grant_reaches", () => {
    expect(() => plainPostgres({ owner: "app_owner", roles: ["app_owner", "app_runtime"] })).toThrow(/app_owner is the owner/);
  });
});
