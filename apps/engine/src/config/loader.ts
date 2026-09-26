import fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config, type Provider, type AgentEntry, type Role } from "@punch/shared";
import type { z } from "zod";
import { EventEmitter } from "node:events";

export class ConfigError extends Error {
  public fieldErrors: { path: string; message: string }[];

  constructor(message: string, fieldErrors: { path: string; message: string }[] = []) {
    super(message);
    this.name = "ConfigError";
    this.fieldErrors = fieldErrors;
  }
}

export function getConfigPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.PUNCH_CONFIG) return path.resolve(process.env.PUNCH_CONFIG);
  return path.join(os.homedir(), ".punch", "config.json");
}

function formatZodError(error: z.ZodError<unknown>): { path: string; message: string }[] {
  return error.issues.map((err: z.ZodIssue) => ({
    path: err.path.join("."),
    message: err.message,
  }));
}

export function validateConfig(raw: unknown): Config {
  const result = Config.safeParse(raw);
  if (!result.success) {
    throw new ConfigError("Config schema validation failed", formatZodError(result.error));
  }

  const config = result.data;
  const errors: { path: string; message: string }[] = [];

  // 1. Env presence check: every apiKeyEnv is set
  config.providers.forEach((provider: Provider, idx: number) => {
    if ("apiKeyEnv" in provider && provider.apiKeyEnv) {
      if (!process.env[provider.apiKeyEnv]) {
        errors.push({
          path: `providers.${idx}.apiKeyEnv`,
          message: `Environment variable ${provider.apiKeyEnv} is not set`,
        });
      }
    }
  });

  const providerIds = new Set(config.providers.map((p: Provider) => p.id));
  const agentMap = new Map<string, AgentEntry>(config.agents.map((a: AgentEntry) => [a.id, a]));

  // 2. Cross-field checks
  // every agent references an existing provider
  config.agents.forEach((agent: AgentEntry, idx: number) => {
    if (!providerIds.has(agent.providerId)) {
      errors.push({
        path: `agents.${idx}.providerId`,
        message: `Provider '${agent.providerId}' not found`,
      });
    }
  });

  // pins/chains/rules reference existing agents allowed for that role
  config.policy.pins.forEach((pin: { role: Role; agentId: string }, idx: number) => {
    const agent = agentMap.get(pin.agentId);
    if (!agent) {
      errors.push({
        path: `policy.pins.${idx}.agentId`,
        message: `Agent '${pin.agentId}' not found`,
      });
    } else if (!agent.roles.includes(pin.role)) {
      errors.push({
        path: `policy.pins.${idx}.agentId`,
        message: `Agent '${pin.agentId}' is not allowed for role '${pin.role}'`,
      });
    }
  });

  config.policy.fallbackChains.forEach((chain: { role: Role; agentIds: string[] }, idx: number) => {
    chain.agentIds.forEach((agentId: string, agentIdx: number) => {
      const agent = agentMap.get(agentId);
      if (!agent) {
        errors.push({
          path: `policy.fallbackChains.${idx}.agentIds.${agentIdx}`,
          message: `Agent '${agentId}' not found`,
        });
      } else if (!agent.roles.includes(chain.role)) {
        errors.push({
          path: `policy.fallbackChains.${idx}.agentIds.${agentIdx}`,
          message: `Agent '${agentId}' is not allowed for role '${chain.role}'`,
        });
      }
    });
  });

  config.policy.rules.forEach(
    (rule: { role: Role; agentId: string; difficulty: string }, idx: number) => {
      const agent = agentMap.get(rule.agentId);
      if (!agent) {
        errors.push({
          path: `policy.rules.${idx}.agentId`,
          message: `Agent '${rule.agentId}' not found`,
        });
      } else if (!agent.roles.includes(rule.role)) {
        errors.push({
          path: `policy.rules.${idx}.agentId`,
          message: `Agent '${rule.agentId}' is not allowed for role '${rule.role}'`,
        });
      }
    },
  );

  if (config.defaults.orchestratorAgentId) {
    const agentId = config.defaults.orchestratorAgentId;
    const agent = agentMap.get(agentId);
    if (!agent) {
      errors.push({
        path: `defaults.orchestratorAgentId`,
        message: `Agent '${agentId}' not found`,
      });
    } else if (!agent.roles.includes("orchestrator")) {
      errors.push({
        path: `defaults.orchestratorAgentId`,
        message: `Agent '${agentId}' is not allowed for role 'orchestrator'`,
      });
    }
  }

  // distinctCritic satisfiable
  if (config.policy.distinctCritic) {
    const executors = config.agents
      .filter((a: AgentEntry) => a.roles.includes("executor"))
      .map((a: AgentEntry) => a.id);
    const critics = config.agents
      .filter((a: AgentEntry) => a.roles.includes("critic"))
      .map((a: AgentEntry) => a.id);
    let satisfiable = false;
    for (const e of executors) {
      for (const c of critics) {
        if (e !== c) {
          satisfiable = true;
          break;
        }
      }
      if (satisfiable) break;
    }
    if (!satisfiable) {
      errors.push({
        path: `policy.distinctCritic`,
        message: `distinctCritic is true but no distinct combination of executor and critic exists`,
      });
    }
  }

  if (errors.length > 0) {
    throw new ConfigError("Config semantic validation failed", errors);
  }

  return config;
}

export async function loadConfig(configPath: string): Promise<Config> {
  const content = await fs.readFile(configPath, "utf-8");
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new ConfigError("Config file is not valid JSON", []);
  }
  return validateConfig(raw);
}

export class ConfigManager extends EventEmitter {
  public currentConfig!: Config;
  private watcher?: FSWatcher;
  private debounceTimer?: NodeJS.Timeout;

  constructor(public configPath: string) {
    super();
  }

  async init(): Promise<Config> {
    this.currentConfig = await loadConfig(this.configPath);
    return this.currentConfig;
  }

  watch() {
    this.watcher = watch(this.configPath, (eventType) => {
      if (eventType === "change") {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(async () => {
          try {
            const newConfig = await loadConfig(this.configPath);
            this.currentConfig = newConfig;
            this.emit("change", newConfig);
          } catch (err) {
            if (err instanceof ConfigError) {
              this.emit("error", err);
              // Keeps the last good config
            } else {
              this.emit("error", new Error(`Failed to load config: ${(err as Error).message}`));
            }
          }
        }, 100);
      }
    });
  }

  stop() {
    if (this.watcher) this.watcher.close();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }
}
