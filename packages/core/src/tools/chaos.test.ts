import { describe, it, expect } from "vitest";
import { parseChaosProfile, applyToolChaos } from "./chaos.js";
import { HttpError } from "./http.js";

describe("Chaos Profile Parsing & Tool Injection", () => {
  it("parses run-level and per-tool chaos profile strings", () => {
    const raw = [
      "provider-down:anthropic",
      "stall:researcher",
      "garbage:planner",
      "kill-after:executor:4",
      "tool-500:osv_query",
      "tool:npm_package_metadata:truncate",
      "tool-empty:get_release_notes",
    ];

    const config = parseChaosProfile(raw);

    expect(config.providerDown.has("anthropic")).toBe(true);
    expect(config.stallRoles.has("researcher")).toBe(true);
    expect(config.garbageRoles.has("planner")).toBe(true);
    expect(config.killAfterRoles.get("executor")).toBe(4);
    expect(config.toolChaos.get("osv_query")).toBe("500");
    expect(config.toolChaos.get("npm_package_metadata")).toBe("truncate");
    expect(config.toolChaos.get("get_release_notes")).toBe("empty");
  });

  it("handles comma-separated string inputs and empty inputs gracefully", () => {
    const config = parseChaosProfile("provider-down:gemini, stall:critic");
    expect(config.providerDown.has("gemini")).toBe(true);
    expect(config.stallRoles.has("critic")).toBe(true);

    const empty = parseChaosProfile();
    expect(empty.profiles).toHaveLength(0);
  });

  it("applies 500 tool chaos by throwing transient HttpError", async () => {
    const config = parseChaosProfile(["tool-500:github_get_contents"]);

    await expect(applyToolChaos("github_get_contents", config)).rejects.toThrow(HttpError);

    try {
      await applyToolChaos("github_get_contents", config);
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(500);
      expect(httpErr.errorClass).toBe("transient");
    }
  });

  it("applies truncate and empty tool chaos", async () => {
    const config = parseChaosProfile(["tool-truncate:toolA", "tool-empty:toolB"]);

    const resA = await applyToolChaos("toolA", config);
    expect(resA.intercepted).toBe(true);
    expect(resA.output).toBeDefined();

    const resB = await applyToolChaos("toolB", config);
    expect(resB.intercepted).toBe(true);
    expect(resB.output).toEqual({});

    const resUnconfigured = await applyToolChaos("unconfigured", config);
    expect(resUnconfigured.intercepted).toBe(false);
  });
});
