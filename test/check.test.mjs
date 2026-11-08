import { describe, test, expect } from "bun:test";
import { runCheck } from "./harness.mjs";

// Exit 3 says the check could not run as asked, apart from drift (1, 2); a
// bad flag stops it before it reads anything.
describe("pgspec-check refuses a flag it cannot check by", () => {
  test.each([
    ["an_unknown_flag", ["--bogus"]],
    ["an_unknown_platform", ["--platform=aurora"]],
  ])("%s_exits_3_on_one_line", (_case, args) => {
    const { status, stderr } = runCheck(args);
    expect(status).toBe(3);
    expect(stderr).toStartWith("pgspec-check: ");
    expect(stderr.trim().split("\n")).toHaveLength(1);
  });
});
