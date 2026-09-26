import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  EvidenceRecord,
  SandboxIsolation,
  SandboxRunResult,
  SandboxStepName,
  SandboxStepResult,
  SandboxValidation,
} from "@punch/shared";
import { compareRuns } from "./compare.js";
import {
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_LIMITS,
  DockerExecutor,
  HostExecutor,
  isDockerAvailable,
  type SandboxLimits,
  type StepExecutor,
} from "./docker.js";
import { parseTestOutput } from "./parse-tests.js";
import { nodeRunner, type ProcessRunner } from "./runner.js";

export type PackageManager = "npm" | "pnpm" | "yarn";
export type SandboxMode = "auto" | "host";

/** Anything with a TraceWriter-shaped `write`. */
export interface SandboxTrace {
  write(event: never): unknown;
}

export interface ValidateUpgradeOptions {
  findingId: string;
  /** Repository checkout to validate. It is only read; work happens in throwaway copies. */
  repoDir: string;
  dependency: string;
  from: string;
  to: string;
  /** `auto` uses Docker and refuses without it; `host` is the explicit `--sandbox=host` opt-in. */
  mode?: SandboxMode;
  trace?: SandboxTrace;
  runner?: ProcessRunner;
  limits?: Partial<SandboxLimits>;
  image?: string;
  signal?: AbortSignal;
  /** Directory for throwaway copies. Defaults to the OS temp dir. */
  tmpRoot?: string;
  now?: () => number;
}

export interface ValidateUpgradeResult {
  validation: SandboxValidation;
  evidence: EvidenceRecord[];
}

const LOCKFILES: Record<string, PackageManager> = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
};
const MANIFEST_FILES = ["package.json", ...Object.keys(LOCKFILES)];
const LOG_TAIL_CHARS = 4000;
const DIFF_MAX_CHARS = 20_000;
const NPM_DEFAULT_TEST = /no test specified/i;

export async function detectPackageManager(
  repoDir: string,
): Promise<{ pm: PackageManager; lockfile: string | null }> {
  for (const [file, pm] of Object.entries(LOCKFILES)) {
    if (await exists(path.join(repoDir, file))) return { pm, lockfile: file };
  }
  return { pm: "npm", lockfile: null };
}

export interface RepoScripts {
  build: string | null;
  test: string | null;
}

/** A missing test script, or npm's placeholder, means "no tests"; never faked. */
export function detectScripts(scripts: Record<string, string> | undefined): RepoScripts {
  const test = scripts?.test?.trim();
  return {
    build: scripts?.build?.trim() ? "build" : null,
    test: test && !NPM_DEFAULT_TEST.test(test) ? "test" : null,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function installCommand(
  pm: PackageManager,
  hasLockfile: boolean,
  viaCorepack: boolean,
): string {
  const prefix = viaCorepack && pm !== "npm" ? "corepack " : "";
  if (pm === "pnpm")
    return `${prefix}pnpm install ${hasLockfile ? "--frozen-lockfile" : ""}`.trim();
  if (pm === "yarn")
    return `${prefix}yarn install ${hasLockfile ? "--frozen-lockfile" : ""}`.trim();
  return hasLockfile ? "npm ci" : "npm install";
}

/** Upgrade in place with the repo's own package manager, keeping the dependency's section. */
export function upgradeCommand(
  pm: PackageManager,
  dependency: string,
  to: string,
  section: "dependencies" | "devDependencies" | "optionalDependencies",
  viaCorepack: boolean,
): string {
  const spec = shellQuote(`${dependency}@${to}`);
  const prefix = viaCorepack && pm !== "npm" ? "corepack " : "";
  const flag = { dependencies: "-P", devDependencies: "-D", optionalDependencies: "-O" }[section];
  if (pm === "pnpm") return `${prefix}pnpm add ${flag} ${spec}`;
  if (pm === "yarn") return `${prefix}yarn add ${flag} ${spec}`;
  return `npm install ${flag} ${spec}`;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

async function copyRepo(src: string, dest: string): Promise<void> {
  await fs.cp(src, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: async (file) => {
      const base = path.basename(file);
      if (base === "node_modules" || base === ".git") return false;
      // Symlinks are not followed or copied: they could point at host paths outside the repo.
      const stat = await fs.lstat(file);
      return !stat.isSymbolicLink();
    },
  });
}

async function readFileIf(p: string): Promise<string | null> {
  return fs.readFile(p, "utf-8").catch(() => null);
}

const tail = (text: string) => (text.length > LOG_TAIL_CHARS ? text.slice(-LOG_TAIL_CHARS) : text);

async function changedManifestFiles(
  baselineDir: string,
  candidateDir: string,
  runner: ProcessRunner,
): Promise<{ changedFiles: string[]; diff: string }> {
  const changedFiles: string[] = [];
  let diff = "";
  for (const file of MANIFEST_FILES) {
    const before = await readFileIf(path.join(baselineDir, file));
    const after = await readFileIf(path.join(candidateDir, file));
    if (before === after) continue;
    changedFiles.push(file);
    // `diff` only reads two files; no repository code is executed by it.
    const result = await runner({
      command: "diff",
      args: [
        "-u",
        "--label",
        `a/${file}`,
        "--label",
        `b/${file}`,
        before === null ? "/dev/null" : path.join(baselineDir, file),
        after === null ? "/dev/null" : path.join(candidateDir, file),
      ],
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 15_000,
    });
    if (result.exitCode === 1) diff += result.output;
    else if (result.exitCode !== 0) diff += `--- ${file}: changed (diff unavailable)\n`;
  }
  if (diff.length > DIFF_MAX_CHARS) diff = `${diff.slice(0, DIFF_MAX_CHARS)}\n[diff truncated]\n`;
  return { changedFiles, diff };
}

/**
 * The code-driven validator (plan.md 8.4, decision 9). Baseline install/build/test on a
 * throwaway copy, apply the upgrade to a second copy, candidate install/build/test, compare.
 *
 * Isolation: Docker when available; otherwise it refuses (`NOT_RUN`, isolation `none`) and
 * executes nothing on the host. Only `mode: "host"` runs on the host, recorded in
 * `sandbox.started`. Never throws for repo failures: those are verdicts.
 */
export async function validateUpgrade(
  options: ValidateUpgradeOptions,
): Promise<ValidateUpgradeResult> {
  const now = options.now ?? Date.now;
  const runner = options.runner ?? nodeRunner;
  const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, ...options.limits };
  const evidence: EvidenceRecord[] = [];
  const emit = async (event: Record<string, unknown>) => {
    await (options.trace as { write(e: unknown): unknown } | undefined)?.write(event);
  };
  const runTag = `sandbox:${options.findingId}`;

  const recordEvidence = async (suffix: string, excerpt: string): Promise<string> => {
    const record: EvidenceRecord = {
      id: `ev-${runTag}:${suffix}`,
      kind: "sandbox_run",
      ref: `${runTag}:${suffix}`,
      excerpt: tail(excerpt),
      fetchedAt: now(),
      tool: "sandbox",
    };
    evidence.push(record);
    await emit({ kind: "evidence.recorded", role: "validator", evidence: record });
    return record.id;
  };

  const finish = async (
    validation: Omit<SandboxValidation, "evidenceIds">,
  ): Promise<ValidateUpgradeResult> => {
    const full: SandboxValidation = { ...validation, evidenceIds: evidence.map((e) => e.id) };
    await emit({ kind: "sandbox.finished", findingId: options.findingId, validation: full });
    return { validation: full, evidence };
  };

  const notRun = (
    isolation: SandboxIsolation,
    note: string,
    extra: Partial<SandboxValidation> = {},
  ) =>
    finish({
      isolation,
      note,
      baseline: null,
      candidate: null,
      newFailures: [],
      fixedFailures: [],
      changedFiles: [],
      verdict: "NOT_RUN",
      ...extra,
    });

  // 1. Choose isolation. Nothing below this line touches the repo until it is decided.
  let executor: StepExecutor | null = null;
  if (options.mode === "host") {
    executor = new HostExecutor(runner);
  } else if (await isDockerAvailable(runner)) {
    executor = new DockerExecutor({
      runner,
      image: options.image ?? DEFAULT_SANDBOX_IMAGE,
      limits,
    });
  }
  const isolation: SandboxIsolation = executor?.isolation ?? "none";

  await emit({
    kind: "sandbox.started",
    findingId: options.findingId,
    dependency: options.dependency,
    from: options.from,
    to: options.to,
    isolation,
  });

  if (!executor) {
    const note =
      "not run (no isolation available): Docker is not available and --sandbox=host was not given";
    await recordEvidence("refused", note);
    return notRun("none", note);
  }

  const pkgRaw = await readFileIf(path.join(options.repoDir, "package.json"));
  if (pkgRaw === null) {
    const note = "not run: repository has no package.json";
    await recordEvidence("no-package-json", note);
    return notRun(isolation, note);
  }
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
  } catch {
    const note = "not run: package.json is not valid JSON";
    await recordEvidence("bad-package-json", note);
    return notRun(isolation, note);
  }
  const section = (["dependencies", "devDependencies", "optionalDependencies"] as const).find(
    (s) =>
      typeof (pkg[s] as Record<string, unknown> | undefined)?.[options.dependency] === "string",
  );
  if (!section) {
    const note = `not run: ${options.dependency} is not a direct dependency in package.json (transitive upgrades need an override and are not simulated)`;
    await recordEvidence("not-direct", note);
    return notRun(isolation, note);
  }

  const { pm, lockfile } = await detectPackageManager(options.repoDir);
  const scripts = detectScripts(pkg.scripts as Record<string, string> | undefined);
  const viaCorepack = isolation === "docker";

  const root = await fs.mkdtemp(path.join(options.tmpRoot ?? os.tmpdir(), "punch-sandbox-"));
  const totalController = new AbortController();
  const totalTimer = setTimeout(() => totalController.abort(), limits.totalTimeoutMs);
  const onAbort = () => totalController.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const baseEnv: Record<string, string> = {
    CI: "1",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  };
  const stepEnv: Record<string, string> =
    isolation === "docker"
      ? { ...baseEnv, HOME: "/tmp", npm_config_cache: "/tmp/.npm", COREPACK_HOME: "/tmp/corepack" }
      : {
          ...baseEnv,
          PATH: process.env.PATH ?? "",
          // Keep the host user's ~/.npmrc (registry tokens) out of untrusted install scripts.
          HOME: path.join(root, "home"),
          npm_config_cache: path.join(root, "npm-cache"),
        };

  const runPhase = async (
    phase: "baseline" | "candidate",
    workdir: string,
    installShell: string,
  ): Promise<SandboxRunResult> => {
    const skipped: SandboxStepResult = {
      status: "skipped",
      exitCode: null,
      durationMs: 0,
      logTail: "",
    };
    const results: Record<SandboxStepName, SandboxStepResult> = {
      install: skipped,
      build: skipped,
      test: skipped,
    };
    let testOutput = "";
    const plan: {
      step: SandboxStepName;
      shell: string | null;
      network: boolean;
      timeoutMs: number;
    }[] = [
      { step: "install", shell: installShell, network: true, timeoutMs: limits.installTimeoutMs },
      {
        step: "build",
        shell: scripts.build ? "npm run build" : null,
        network: false,
        timeoutMs: limits.buildTimeoutMs,
      },
      {
        step: "test",
        shell: scripts.test ? "npm test" : null,
        network: false,
        timeoutMs: limits.testTimeoutMs,
      },
    ];
    for (const { step, shell, network, timeoutMs } of plan) {
      let result: SandboxStepResult;
      let output = "";
      const installFailed = results.install.status === "fail";
      if (shell === null || installFailed || totalController.signal.aborted) {
        const reason =
          shell === null
            ? `no ${step} script`
            : installFailed
              ? "install failed"
              : "validation aborted";
        result = {
          status: "skipped",
          exitCode: null,
          durationMs: 0,
          logTail: `skipped: ${reason}`,
        };
      } else {
        const run = await executor.exec({
          shell,
          workdir,
          network,
          timeoutMs,
          env: stepEnv,
          signal: totalController.signal,
        });
        output = run.output;
        const suffix = run.timedOut
          ? "\n[timed out: step exceeded its time cap]"
          : run.aborted
            ? "\n[aborted]"
            : "";
        result = {
          status: run.exitCode === 0 && !run.timedOut && !run.aborted ? "pass" : "fail",
          exitCode: run.exitCode,
          durationMs: run.durationMs,
          logTail: tail(run.output + suffix),
        };
      }
      results[step] = result;
      if (step === "test") testOutput = output;
      await emit({ kind: "sandbox.step", findingId: options.findingId, phase, step, result });
      await recordEvidence(
        `${phase}:${step}`,
        `[${phase} ${step}: ${result.status}, exit ${result.exitCode}]\n${result.logTail}`,
      );
    }
    const parsed =
      results.test.status === "skipped"
        ? { counts: null, failingTests: [] }
        : parseTestOutput(testOutput);
    return { ...results, counts: parsed.counts, failingTests: parsed.failingTests };
  };

  try {
    const baselineDir = path.join(root, "baseline");
    const candidateDir = path.join(root, "candidate");
    await fs.mkdir(path.join(root, "home"), { recursive: true });
    await copyRepo(options.repoDir, baselineDir);
    await copyRepo(options.repoDir, candidateDir);

    const baseline = await runPhase(
      "baseline",
      baselineDir,
      installCommand(pm, lockfile !== null, viaCorepack),
    );
    if (totalController.signal.aborted) {
      return await notRun(isolation, "not run: validation aborted or exceeded its total time cap", {
        baseline,
      });
    }
    if (baseline.install.status !== "pass") {
      return await notRun(
        isolation,
        "not run: the baseline install failed, so there is nothing to compare the upgrade against",
        { baseline },
      );
    }

    const candidate = await runPhase(
      "candidate",
      candidateDir,
      upgradeCommand(pm, options.dependency, options.to, section, viaCorepack),
    );
    if (totalController.signal.aborted) {
      return await notRun(isolation, "not run: validation aborted or exceeded its total time cap", {
        baseline,
        candidate,
      });
    }

    const comparison = compareRuns(baseline, candidate);
    const { changedFiles, diff } = await changedManifestFiles(baselineDir, candidateDir, runner);
    const modeNote =
      isolation === "host"
        ? "ran on the host in a throwaway copy (--sandbox=host opt-in): only the time cap is enforced, no CPU, memory or network limits"
        : `ran in Docker (${options.image ?? DEFAULT_SANDBOX_IMAGE}), network only for install`;
    return await finish({
      isolation,
      note: [comparison.note, modeNote, `package manager: ${pm}`].filter(Boolean).join("; "),
      baseline,
      candidate,
      newFailures: comparison.newFailures,
      fixedFailures: comparison.fixedFailures,
      changedFiles,
      diff: diff || undefined,
      verdict: comparison.verdict,
    });
  } finally {
    clearTimeout(totalTimer);
    options.signal?.removeEventListener("abort", onAbort);
    await fs.rm(root, { recursive: true, force: true });
  }
}
