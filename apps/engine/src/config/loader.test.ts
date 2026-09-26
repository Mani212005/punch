import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateConfig, ConfigError, ConfigManager } from "./loader.js";
import fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";

vi.mock("node:fs/promises");
vi.mock("node:fs");

describe("Config Loader Schema Rules", () => {
  let envOrig: NodeJS.ProcessEnv;

  beforeEach(() => {
    envOrig = { ...process.env };
    process.env.TEST_API_KEY = "123";
  });

  afterEach(() => {
    process.env = envOrig;
    vi.clearAllMocks();
  });

  const getValidConfig = () => ({
    version: 1,
    providers: [
      { id: "anthropic", kind: "anthropic", apiKeyEnv: "TEST_API_KEY" },
      { id: "cli", kind: "claude-code" },
    ],
    agents: [
      {
        id: "agent1",
        displayName: "A1",
        providerId: "anthropic",
        model: "m1",
        costTier: "high",
        roles: ["orchestrator", "planner", "researcher", "executor"],
        strengths: "good",
      },
      {
        id: "agent2",
        displayName: "A2",
        providerId: "cli",
        model: "m2",
        costTier: "low",
        roles: ["critic"],
        strengths: "good",
      },
    ],
    policy: {
      pins: [{ role: "orchestrator", agentId: "agent1" }],
      fallbackChains: [],
      rules: [],
      preferences: "pref",
      distinctCritic: true,
      autoConfirmBelowConfidence: 0.6,
      maxReplacementsPerSlot: 2,
      stallAfterMs: { api: 45000, cli: 120000 },
    },
    budgets: {
      maxSteps: 10,
      maxUsd: 1,
      maxWallClockMs: 1000,
    },
    defaults: { mode: "auto" },
  });

  it("validates a well-formed config", () => {
    const config = validateConfig(getValidConfig());
    expect(config.version).toBe(1);
  });

  it("fails if version is not 1", () => {
    const cfg = getValidConfig();
    (cfg as unknown as { version: number }).version = 2;
    expect(() => validateConfig(cfg)).toThrow(ConfigError);
    try {
      validateConfig(cfg);
    } catch (err) {
      const error = err as ConfigError;
      expect(error.fieldErrors.some((e: { path: string }) => e.path === "version")).toBe(true);
    }
  });

  it("fails if provider kind is unknown", () => {
    const cfg = getValidConfig();
    (cfg.providers[0] as unknown as { kind: string }).kind = "unknown-kind";
    try {
      validateConfig(cfg);
    } catch (err) {
      const error = err as ConfigError;
      expect(
        error.fieldErrors.some(
          (e: { path: string }) => e.path === "providers.0.kind" || e.path === "providers.0",
        ),
      ).toBe(true);
    }
  });

  it("fails if API provider is missing apiKeyEnv", () => {
    const cfg = getValidConfig();
    delete (cfg.providers[0] as unknown as { apiKeyEnv?: string }).apiKeyEnv;
    try {
      validateConfig(cfg);
    } catch (err) {
      const error = err as ConfigError;
      expect(
        error.fieldErrors.some((e: { path: string }) => e.path.startsWith("providers.0")),
      ).toBe(true);
    }
  });

  it("fails if agent costTier is invalid", () => {
    const cfg = getValidConfig();
    (cfg.agents[0] as unknown as { costTier: string }).costTier = "super-high";
    try {
      validateConfig(cfg);
    } catch (err) {
      const error = err as ConfigError;
      expect(error.fieldErrors.some((e: { path: string }) => e.path === "agents.0.costTier")).toBe(
        true,
      );
    }
  });

  it("fails if agent roles are empty", () => {
    const cfg = getValidConfig();
    cfg.agents[0]!.roles = [];
    try {
      validateConfig(cfg);
    } catch (err) {
      const error = err as ConfigError;
      expect(error.fieldErrors.some((e: { path: string }) => e.path === "agents.0.roles")).toBe(
        true,
      );
    }
  });

  it("fails if policy.autoConfirmBelowConfidence is out of bounds", () => {
    const cfg = getValidConfig();
    cfg.policy.autoConfirmBelowConfidence = 1.5;
    try {
      validateConfig(cfg);
    } catch (err) {
      const error = err as ConfigError;
      expect(
        error.fieldErrors.some(
          (e: { path: string }) => e.path === "policy.autoConfirmBelowConfidence",
        ),
      ).toBe(true);
    }
  });

  it("fails if negative budget", () => {
    const cfg = getValidConfig();
    cfg.budgets.maxSteps = -5;
    try {
      validateConfig(cfg);
    } catch (err) {
      const error = err as ConfigError;
      expect(error.fieldErrors.some((e: { path: string }) => e.path === "budgets.maxSteps")).toBe(
        true,
      );
    }
  });

  it("fails if required env var is missing", () => {
    delete process.env.TEST_API_KEY;
    try {
      validateConfig(getValidConfig());
    } catch (err) {
      const error = err as ConfigError;
      expect(error.fieldErrors[0]!.path).toBe("providers.0.apiKeyEnv");
    }
  });

  it("fails if agent provider is missing", () => {
    const cfg = getValidConfig();
    cfg.agents[0]!.providerId = "unknown";
    try {
      validateConfig(cfg);
    } catch (err) {
      const error = err as ConfigError;
      expect(error.fieldErrors[0]!.path).toBe("agents.0.providerId");
    }
  });

  it("fails if pinned agent does not exist", () => {
    const cfg = getValidConfig();
    cfg.policy.pins[0]!.agentId = "unknown";
    try {
      validateConfig(cfg);
    } catch (err) {
      const error = err as ConfigError;
      expect(error.fieldErrors[0]!.path).toBe("policy.pins.0.agentId");
    }
  });

  it("fails if pinned agent is missing role", () => {
    const cfg = getValidConfig();
    (cfg.policy.pins[0] as unknown as { role: string }).role = "critic"; // agent1 does not have critic role
    try {
      validateConfig(cfg);
    } catch (err) {
      const error = err as ConfigError;
      expect(error.fieldErrors[0]!.path).toBe("policy.pins.0.agentId");
    }
  });

  it("fails if distinctCritic unsatisfiable", () => {
    const cfg = getValidConfig();
    cfg.agents[0]!.roles.push("critic");
    cfg.agents.pop(); // remove agent2, only agent1 exists for executor and critic
    try {
      validateConfig(cfg);
    } catch (err) {
      const error = err as ConfigError;
      expect(error.fieldErrors[0]!.path).toBe("policy.distinctCritic");
    }
  });

  it("ConfigManager watches and reloads", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(getValidConfig()));
    let watchCallback: unknown;
    vi.mocked(watch).mockImplementation((path, cb) => {
      watchCallback = cb;
      return { close: vi.fn() } as unknown as FSWatcher;
    });

    const manager = new ConfigManager("config.json");
    await manager.init();
    expect(manager.currentConfig.version).toBe(1);

    manager.watch();
    const newConfig = {
      ...getValidConfig(),
      budgets: { ...getValidConfig().budgets, maxSteps: 20 },
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(newConfig));

    const promise = new Promise<void>((resolve) => {
      manager.on("change", (cfg) => {
        expect(cfg.budgets.maxSteps).toBe(20);
        resolve();
      });
    });
    (watchCallback as (event: string) => void)("change");
    await promise;
    manager.stop();
  });

  it("ConfigManager keeps last good config on error", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(getValidConfig()));
    let watchCallback: unknown;
    vi.mocked(watch).mockImplementation((path, cb) => {
      watchCallback = cb;
      return { close: vi.fn() } as unknown as FSWatcher;
    });

    const manager = new ConfigManager("config.json");
    await manager.init();
    manager.watch();

    vi.mocked(fs.readFile).mockResolvedValue("invalid json");
    const promise = new Promise<void>((resolve) => {
      manager.on("error", (err) => {
        expect(err).toBeInstanceOf(ConfigError);
        expect(manager.currentConfig.budgets.maxSteps).toBe(10); // last good
        resolve();
      });
    });

    (watchCallback as (event: string) => void)("change");
    await promise;
    manager.stop();
  });
});
