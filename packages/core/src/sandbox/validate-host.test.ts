import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@punch/shared";
import { TraceEvent as TraceEventSchema } from "@punch/shared";
import { validateUpgrade } from "./validate.js";

// Real-process sandbox tests: real npm installs on fixture repos (host
// opt-in path) and real Docker runs. They eat CPU/disk and used to run in the
// same vitest invocation as the timing-sensitive unit tests, starving them
// under load. They live in this file so the "integration" vitest project can
// run them separately and serially with a generous timeout; see
// packages/core/vitest.config.ts. Keep anything with an injected (fake)
// runner in validate.test.ts instead.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "../../../../fixtures/sandbox");

// Mirrors the helper in validate.test.ts; kept local so this file stands alone.
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
