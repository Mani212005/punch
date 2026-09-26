import { describe, expect, it } from "vitest";
import { buildProgram, NotImplementedError } from "./cli.js";

const cases: string[][] = [
  ["serve"],
  ["kill", "run1", "researcher"],
  ["approve", "run1"],
  ["deny", "run1"],
];

describe("punch CLI stubs", () => {
  it.each(cases)("%s is a not-implemented stub", async (...args) => {
    await expect(buildProgram().parseAsync(args, { from: "user" })).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it("lists every subcommand in help", () => {
    const help = buildProgram().helpInformation();
    for (const name of ["serve", "run", "kill", "approve", "deny", "config"]) {
      expect(help).toContain(name);
    }
  });
});
