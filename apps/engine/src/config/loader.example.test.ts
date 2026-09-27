import { describe, it, expect } from "vitest";
import { loadConfig } from "./loader.js";
import path from "node:path";

describe("Config Loader - example", () => {
  it("loads config.example.json without errors", async () => {
    const originalEnv = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const configPath = path.resolve("../../config.example.json");
      await expect(loadConfig(configPath)).resolves.toBeDefined();
    } finally {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    }
  });
});
