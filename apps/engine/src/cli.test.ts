import { describe, expect, it } from "vitest";
import { buildProgram } from "./cli.js";

describe("punch CLI", () => {
  it("lists every subcommand in help", () => {
    const help = buildProgram().helpInformation();
    for (const name of ["serve", "run", "kill", "approve", "deny", "config"]) {
      expect(help).toContain(name);
    }
  });

  it("registers the serve options", () => {
    const serve = buildProgram().commands.find((command) => command.name() === "serve");
    expect(serve).toBeDefined();
    expect(serve?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        "--port",
        "--host",
        "--pairing-token",
        "--viewer-token",
        "--web-origin",
        "--runs-dir",
        "--tunnel",
        "--config",
      ]),
    );
  });
});
