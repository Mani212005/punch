import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TraceEvent } from "@punch/shared";
import { TraceEvent as TraceEventSchema } from "@punch/shared";
import { buildDockerRunArgs, DEFAULT_SANDBOX_LIMITS, DockerExecutor } from "./docker.js";
import {
  nodeRunner,
  type ProcessRunner,
  type ProcessRequest,
  type ProcessResult,
} from "./runner.js";
import {
  detectPackageManager,
  detectScripts,
  installCommand,
  upgradeCommand,
  validateUpgrade,
} from "./validate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "../../../../fixtures/sandbox");

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "punch-sbx-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeRepo(
  pkg: Record<string, unknown>,
  files: Record<string, string> = { "package-lock.json": "{}" },
): string {
  const dir = path.join(tmp, "repo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const basePkg = {
  name: "app",
  scripts: { build: "tsc", test: "vitest run" },
  dependencies: { foo: "^2.1.4" },
};

const ok = (output = ""): ProcessResult => ({
  exitCode: 0,
  output,
  timedOut: false,
  aborted: false,
  durationMs: 5,
});
const bad = (output = "", exitCode = 1): ProcessResult => ({
  exitCode,
  output,
  timedOut: false,
  aborted: false,
  durationMs: 5,
});

interface Call {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs: number;
}
interface StepCall extends Call {
  shell: string;
  phase: "baseline" | "candidate";
  network: string;
}

/** Fake docker and host: `handler` decides each step's result from the phase and shell. */
function fakeRunner(
  handler: (step: {
    shell: string;
    phase: "baseline" | "candidate";
    workdir: string;
  }) => ProcessResult,
  options: { docker: boolean } = { docker: true },
) {
  const calls: Call[] = [];
  const steps: StepCall[] = [];
  const runner: ProcessRunner = async (req: ProcessRequest) => {
    calls.push({ command: req.command, args: req.args, env: req.env, timeoutMs: req.timeoutMs });
    if (req.command === "docker" && req.args[0] === "info")
      return options.docker ? ok("27.0.1\n") : bad("Cannot connect");
    if (req.command === "docker" && req.args[0] === "rm") return ok();
    if (req.command === "diff") return nodeRunner(req);
    let shell: string;
    let workdir: string;
    let network = "n/a";
    if (req.command === "docker") {
      shell = req.args[req.args.length - 1]!;
      workdir = req.args[req.args.indexOf("-v") + 1]!.split(":")[0]!;
      network = req.args[req.args.indexOf("--network") + 1]!;
    } else {
      shell = req.args[1]!;
      workdir = req.cwd!;
    }
    const phase = path.basename(workdir) as "baseline" | "candidate";
    steps.push({
      command: req.command,
      args: req.args,
      env: req.env,
      timeoutMs: req.timeoutMs,
      shell,
      phase,
      network,
    });
    if (phase === "candidate" && /(npm install|pnpm add|yarn add)/.test(shell)) {
      const file = path.join(workdir, "package.json");
      fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace("^2.1.4", "^2.4.0"));
    }
    return handler({ shell, phase, workdir });
  };
  return { runner, calls, steps };
}

function traceSink() {
  const events: TraceEvent[] = [];
  return {
    events,
    trace: {
      write: (e: unknown) => {
        events.push(
          TraceEventSchema.parse({ runId: "r", seq: events.length, ts: 1, ...(e as object) }),
        );
      },
    },
  };
}

const vitestPass = "      Tests  2 passed (2)";
const vitestFail = " FAIL  a.test.ts > b works\n      Tests  1 failed | 1 passed (2)";

describe("command construction", () => {
  it("detects the package manager from lockfiles", async () => {
    const npm = makeRepo(basePkg, { "package-lock.json": "{}" });
    expect(await detectPackageManager(npm)).toEqual({ pm: "npm", lockfile: "package-lock.json" });
    fs.rmSync(path.join(npm, "package-lock.json"));
    fs.writeFileSync(path.join(npm, "pnpm-lock.yaml"), "");
    expect(await detectPackageManager(npm)).toEqual({ pm: "pnpm", lockfile: "pnpm-lock.yaml" });
    fs.rmSync(path.join(npm, "pnpm-lock.yaml"));
    fs.writeFileSync(path.join(npm, "yarn.lock"), "");
    expect(await detectPackageManager(npm)).toEqual({ pm: "yarn", lockfile: "yarn.lock" });
    fs.rmSync(path.join(npm, "yarn.lock"));
    expect(await detectPackageManager(npm)).toEqual({ pm: "npm", lockfile: null });
  });

  it("builds install and upgrade commands per package manager", () => {
    expect(installCommand("npm", true, true)).toBe("npm ci");
    expect(installCommand("npm", false, true)).toBe("npm install");
    expect(installCommand("pnpm", true, true)).toBe("corepack pnpm install --frozen-lockfile");
    expect(installCommand("yarn", false, false)).toBe("yarn install");
    expect(upgradeCommand("npm", "foo", "2.4.0", "dependencies", true)).toBe(
      "npm install -P 'foo@2.4.0'",
    );
    expect(upgradeCommand("pnpm", "foo", "2.4.0", "devDependencies", true)).toBe(
      "corepack pnpm add -D 'foo@2.4.0'",
    );
    expect(upgradeCommand("yarn", "@a/b", "1.0.0", "dependencies", false)).toBe(
      "yarn add -P '@a/b@1.0.0'",
    );
  });

  it("treats a missing or placeholder test script as no tests", () => {
    expect(detectScripts({ build: "tsc", test: "vitest" })).toEqual({
      build: "build",
      test: "test",
    });
    expect(detectScripts({})).toEqual({ build: null, test: null });
    expect(detectScripts({ test: 'echo "Error: no test specified" && exit 1' }).test).toBeNull();
  });

  it("quotes hostile version strings", () => {
    expect(upgradeCommand("npm", "foo", "1.0.0; rm -rf /", "dependencies", false)).toBe(
      "npm install -P 'foo@1.0.0; rm -rf /'",
    );
  });
});

describe("docker isolation flags", () => {
  const input = {
    name: "c1",
    image: "node:22.11.0-bookworm-slim",
    workdir: "/tmp/w",
    shell: "npm test",
    limits: DEFAULT_SANDBOX_LIMITS,
    env: { CI: "1" },
    user: "1000:1000",
  };

  it("caps cpu, memory, pids and drops capabilities", () => {
    const args = buildDockerRunArgs({ ...input, network: false });
    expect(args).toEqual(
      expect.arrayContaining([
        "--rm",
        "--cpus",
        "2",
        "--memory",
        "2048m",
        "--memory-swap",
        "2048m",
        "--pids-limit",
        "512",
        "--cap-drop",
        "ALL",
        "no-new-privileges",
      ]),
    );
    expect(args.slice(-4)).toEqual([input.image, "sh", "-c", "npm test"]);
    expect(args).toContain("/tmp/w:/work");
  });

  it("grants network only when asked", () => {
    expect(buildDockerRunArgs({ ...input, network: true })).toContain("bridge");
    const off = buildDockerRunArgs({ ...input, network: false });
    expect(off[off.indexOf("--network") + 1]).toBe("none");
  });

  it("force-removes the container even when the run rejects", async () => {
    const calls: string[][] = [];
    const runner: ProcessRunner = async (req) => {
      calls.push(req.args);
      if (req.args[0] === "run") throw new Error("crash");
      return ok();
    };
    const exec = new DockerExecutor({
      runner,
      nameSuffix: () => "abc",
      user: "1:1",
      clientEnv: {},
    });
    await expect(
      exec.exec({ shell: "x", workdir: "/w", network: false, timeoutMs: 1, env: {} }),
    ).rejects.toThrow("crash");
    expect(calls.at(-1)).toEqual(["rm", "-f", "-v", "punch-sbx-abc"]);
  });

  it("force-removes the container after a timeout result", async () => {
    const calls: string[][] = [];
    const runner: ProcessRunner = async (req) => {
      calls.push(req.args);
      return req.args[0] === "run" ? { ...bad("", 137), timedOut: true } : ok();
    };
    const exec = new DockerExecutor({ runner, nameSuffix: () => "t", user: "1:1", clientEnv: {} });
    const result = await exec.exec({
      shell: "x",
      workdir: "/w",
      network: false,
      timeoutMs: 1,
      env: {},
    });
    expect(result.timedOut).toBe(true);
    expect(calls.map((c) => c[0])).toEqual(["run", "rm"]);
  });
});

describe("validateUpgrade with an injected runner", () => {
  const passing = ({ shell }: { shell: string }) => (shell === "npm test" ? ok(vitestPass) : ok());

  it("yields NOT_RUN and executes nothing when Docker is unavailable", async () => {
    const repo = makeRepo(basePkg);
    const { runner, calls } = fakeRunner(passing, { docker: false });
    const sink = traceSink();
    const tmpRoot = path.join(tmp, "work");
    fs.mkdirSync(tmpRoot);

    const { validation, evidence } = await validateUpgrade({
      findingId: "f1",
      repoDir: repo,
      dependency: "foo",
      from: "2.1.4",
      to: "2.4.0",
      runner,
      trace: sink.trace,
      tmpRoot,
    });

    expect(validation.verdict).toBe("NOT_RUN");
    expect(validation.isolation).toBe("none");
    expect(validation.note).toMatch(/no isolation available/);
    expect(validation.baseline).toBeNull();
    // The only process started is the docker probe; no repo command, no copy of the repo.
    expect(calls.map((c) => `${c.command} ${c.args[0]}`)).toEqual(["docker info"]);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
    expect(sink.events.map((e) => e.kind)).toEqual([
      "sandbox.started",
      "evidence.recorded",
      "sandbox.finished",
    ]);
    expect(sink.events[0]).toMatchObject({ isolation: "none" });
    expect(evidence[0]!.kind).toBe("sandbox_run");
  });

  it("passes a compatible upgrade in Docker, with network only for install", async () => {
    const repo = makeRepo(basePkg);
    const { runner, steps } = fakeRunner(passing);
    const sink = traceSink();

    const { validation, evidence } = await validateUpgrade({
      findingId: "f1",
      repoDir: repo,
      dependency: "foo",
      from: "2.1.4",
      to: "2.4.0",
      runner,
      trace: sink.trace,
    });

    expect(validation.verdict).toBe("PASS");
    expect(validation.isolation).toBe("docker");
    expect(validation.baseline?.counts).toEqual({ total: 2, passed: 2, failed: 0, skipped: 0 });
    expect(validation.candidate?.counts?.passed).toBe(2);
    expect(validation.changedFiles).toEqual(["package.json"]);
    expect(validation.diff).toContain('-    "foo": "^2.1.4"');
    expect(validation.diff).toContain('+    "foo": "^2.4.0"');

    expect(steps.map((s) => [s.phase, s.shell, s.network])).toEqual([
      ["baseline", "npm ci", "bridge"],
      ["baseline", "npm run build", "none"],
      ["baseline", "npm test", "none"],
      ["candidate", "npm install -P 'foo@2.4.0'", "bridge"],
      ["candidate", "npm run build", "none"],
      ["candidate", "npm test", "none"],
    ]);
    // No host secrets reach the container.
    for (const s of steps) expect(s.args.join(" ")).not.toMatch(/API_KEY|TOKEN/);

    const kinds = sink.events.map((e) => e.kind);
    expect(kinds[0]).toBe("sandbox.started");
    expect(kinds.filter((k) => k === "sandbox.step")).toHaveLength(6);
    expect(kinds.at(-1)).toBe("sandbox.finished");
    expect(evidence.every((e) => e.kind === "sandbox_run")).toBe(true);
    expect(evidence).toHaveLength(6);
    expect(validation.evidenceIds).toEqual(evidence.map((e) => e.id));
    const evEvent = sink.events.find((e) => e.kind === "evidence.recorded");
    expect(evEvent).toMatchObject({ role: "validator" });
  });

  it("does not touch the source repo", async () => {
    const repo = makeRepo(basePkg);
    const before = fs.readFileSync(path.join(repo, "package.json"), "utf-8");
    await validateUpgrade({
      findingId: "f",
      repoDir: repo,
      dependency: "foo",
      from: "2.1.4",
      to: "2.4.0",
      runner: fakeRunner(passing).runner,
    });
    expect(fs.readFileSync(path.join(repo, "package.json"), "utf-8")).toBe(before);
  });

  it("fails a breaking upgrade and names the failing tests", async () => {
    const repo = makeRepo(basePkg);
    const { runner } = fakeRunner(({ shell, phase }) =>
      shell === "npm test" ? (phase === "baseline" ? ok(vitestPass) : bad(vitestFail)) : ok(),
    );
    const { validation } = await validateUpgrade({
      findingId: "f",
      repoDir: repo,
      dependency: "foo",
      from: "2.1.4",
      to: "2.4.0",
      runner,
    });
    expect(validation.verdict).toBe("FAIL");
    expect(validation.newFailures).toEqual(["a.test.ts > b works"]);
    expect(validation.candidate?.failingTests).toEqual(["a.test.ts > b works"]);
  });

  it("does not blame the upgrade for pre-existing failures", async () => {
    const repo = makeRepo(basePkg);
    const { runner } = fakeRunner(({ shell }) => (shell === "npm test" ? bad(vitestFail) : ok()));
    const { validation } = await validateUpgrade({
      findingId: "f",
      repoDir: repo,
      dependency: "foo",
      from: "2.1.4",
      to: "2.4.0",
      runner,
    });
    expect(validation.verdict).toBe("PASS");
    expect(validation.newFailures).toEqual([]);
  });

  it("is NOT_RUN, never PASS, when the repo has no test script", async () => {
    const repo = makeRepo({ ...basePkg, scripts: { build: "tsc" } });
    const { runner, steps } = fakeRunner(() => ok());
    const { validation } = await validateUpgrade({
      findingId: "f",
      repoDir: repo,
      dependency: "foo",
      from: "2.1.4",
      to: "2.4.0",
      runner,
    });
    expect(validation.verdict).toBe("NOT_RUN");
    expect(validation.note).toMatch(/no tests/);
    expect(validation.candidate?.test.status).toBe("skipped");
    expect(steps.some((s) => s.shell === "npm test")).toBe(false);
  });

  it("fails when the candidate install fails and skips later steps", async () => {
    const repo = makeRepo(basePkg);
    const { runner, steps } = fakeRunner(({ shell, phase }) =>
      phase === "candidate" && shell.startsWith("npm install")
        ? bad("ERESOLVE")
        : shell === "npm test"
          ? ok(vitestPass)
          : ok(),
    );
    const { validation } = await validateUpgrade({
      findingId: "f",
      repoDir: repo,
      dependency: "foo",
      from: "2.1.4",
      to: "2.4.0",
      runner,
    });
    expect(validation.verdict).toBe("FAIL");
    expect(validation.candidate?.build.status).toBe("skipped");
    expect(steps.filter((s) => s.phase === "candidate")).toHaveLength(1);
  });

  it("is NOT_RUN when the baseline install fails", async () => {
    const repo = makeRepo(basePkg);
    const { runner } = fakeRunner(({ shell }) => (shell === "npm ci" ? bad("no network") : ok()));
    const { validation } = await validateUpgrade({
      findingId: "f",
      repoDir: repo,
      dependency: "foo",
      from: "2.1.4",
      to: "2.4.0",
      runner,
    });
    expect(validation.verdict).toBe("NOT_RUN");
    expect(validation.candidate).toBeNull();
    expect(validation.baseline?.install.status).toBe("fail");
  });

  it("is NOT_RUN for a transitive dependency", async () => {
    const repo = makeRepo(basePkg);
    const { runner, steps } = fakeRunner(passing);
    const { validation } = await validateUpgrade({
      findingId: "f",
      repoDir: repo,
      dependency: "bar",
      from: "1.0.0",
      to: "1.1.0",
      runner,
    });
    expect(validation.verdict).toBe("NOT_RUN");
    expect(validation.note).toMatch(/not a direct dependency/);
    expect(steps).toHaveLength(0);
  });

  it("enforces the time caps per step and fails a timed-out candidate", async () => {
    const repo = makeRepo(basePkg);
    const { runner, steps } = fakeRunner(({ shell, phase }) =>
      phase === "candidate" && shell === "npm test"
        ? { ...bad("", 137), timedOut: true }
        : shell === "npm test"
          ? ok(vitestPass)
          : ok(),
    );
    const { validation } = await validateUpgrade({
      findingId: "f",
      repoDir: repo,
      dependency: "foo",
      from: "2.1.4",
      to: "2.4.0",
      runner,
      limits: {
        installTimeoutMs: 11,
        buildTimeoutMs: 22,
        testTimeoutMs: 33,
        cpus: 1,
        memoryMb: 512,
      },
    });
    expect(steps.slice(0, 3).map((s) => s.timeoutMs)).toEqual([11, 22, 33]);
    expect(steps[0]!.args).toEqual(expect.arrayContaining(["--cpus", "1", "--memory", "512m"]));
    expect(validation.candidate?.test.logTail).toMatch(/timed out/);
    expect(validation.verdict).toBe("FAIL");
  });

  it("aborts, reports NOT_RUN and still cleans up its copies", async () => {
    const repo = makeRepo(basePkg);
    const controller = new AbortController();
    const tmpRoot = path.join(tmp, "work");
    fs.mkdirSync(tmpRoot);
    const { runner } = fakeRunner(({ shell }) => {
      controller.abort();
      return shell === "npm test" ? ok(vitestPass) : ok();
    });
    const { validation } = await validateUpgrade({
      findingId: "f",
      repoDir: repo,
      dependency: "foo",
      from: "2.1.4",
      to: "2.4.0",
      runner,
      signal: controller.signal,
      tmpRoot,
    });
    expect(validation.verdict).toBe("NOT_RUN");
    expect(validation.note).toMatch(/aborted/);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it("runs on the host only with the explicit opt-in, and records it in the trace", async () => {
    const repo = makeRepo(basePkg);
    const { runner, calls, steps } = fakeRunner(passing, { docker: false });
    const sink = traceSink();
    const { validation } = await validateUpgrade({
      findingId: "f",
      repoDir: repo,
      dependency: "foo",
      from: "2.1.4",
      to: "2.4.0",
      runner,
      trace: sink.trace,
      mode: "host",
    });
    expect(validation.isolation).toBe("host");
    expect(validation.verdict).toBe("PASS");
    expect(validation.note).toMatch(/--sandbox=host/);
    expect(sink.events[0]).toMatchObject({ kind: "sandbox.started", isolation: "host" });
    expect(calls.some((c) => c.command === "docker")).toBe(false);
    // Host steps run in a temp copy with a scrubbed environment (no API keys, no real HOME).
    for (const s of steps) {
      expect(s.command).toBe("sh");
      expect(s.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(s.env?.HOME).toMatch(/punch-sandbox-/);
    }
  });
});

describe("validateUpgrade on fixture repos (real host runner)", () => {
  it("PASS for the compatible upgrade on the host opt-in path", async () => {
    const sink = traceSink();
    const { validation } = await validateUpgrade({
      findingId: "pass",
      repoDir: path.join(fixtures, "pass-repo"),
      dependency: "greeter",
      from: "1.0.0",
      to: "file:./vendor/greeter-2",
      mode: "host",
      trace: sink.trace,
    });
    expect(validation.note ?? "").not.toMatch(/failed/);
    expect(validation.verdict).toBe("PASS");
    expect(validation.candidate?.counts).toMatchObject({ total: 2, passed: 2, failed: 0 });
    expect(validation.changedFiles).toContain("package.json");
    expect(sink.events[0]).toMatchObject({ kind: "sandbox.started", isolation: "host" });
  }, 120_000);

  it("FAIL naming the failing tests for the breaking upgrade", async () => {
    const { validation } = await validateUpgrade({
      findingId: "break",
      repoDir: path.join(fixtures, "break-repo"),
      dependency: "greeter",
      from: "1.0.0",
      to: "file:./vendor/greeter-2",
      mode: "host",
    });
    expect(validation.verdict).toBe("FAIL");
    expect(validation.baseline?.test.status).toBe("pass");
    expect(validation.newFailures.sort()).toEqual(["greets by name", "greets the world"]);
  }, 120_000);
});

function dockerReady(): boolean {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

// Opt-in: needs a running Docker daemon and pulls the pinned Node image (network).
describe.skipIf(!dockerReady())("validateUpgrade in real Docker", () => {
  it("passes and fails the fixtures and leaves no container behind", async () => {
    const pass = await validateUpgrade({
      findingId: "pass",
      repoDir: path.join(fixtures, "pass-repo"),
      dependency: "greeter",
      from: "1.0.0",
      to: "file:./vendor/greeter-2",
    });
    expect(pass.validation.isolation).toBe("docker");
    expect(pass.validation.verdict).toBe("PASS");

    const broken = await validateUpgrade({
      findingId: "break",
      repoDir: path.join(fixtures, "break-repo"),
      dependency: "greeter",
      from: "1.0.0",
      to: "file:./vendor/greeter-2",
    });
    expect(broken.validation.verdict).toBe("FAIL");
    expect(broken.validation.newFailures.sort()).toEqual(["greets by name", "greets the world"]);

    const left = execFileSync("docker", [
      "ps",
      "-a",
      "--filter",
      "name=punch-sbx-",
      "--format",
      "{{.Names}}",
    ])
      .toString()
      .trim();
    expect(left).toBe("");
  }, 600_000);
});
