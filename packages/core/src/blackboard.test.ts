import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TraceEvent } from "@punch/shared";
import {
  Blackboard,
  BlackboardError,
  BlackboardNotFoundError,
  BlackboardOverwriteError,
  BlackboardValidationError,
  type BlackboardEntry,
  type TraceSink,
} from "./blackboard.js";

const writerResearcher = { role: "researcher", agentId: "agent-1", subtaskId: "task-1" };
const writerExecutor = { role: "executor", agentId: "agent-2", subtaskId: "task-2" };

describe("Blackboard", () => {
  describe("write and get", () => {
    it("writes an entry with defaults and retrieves it", () => {
      const bb = new Blackboard();
      const entry = bb.write({
        key: "deps",
        value: { packages: ["lodash", "express"] },
        evidence: [
          { source: "package.json", quote: '"lodash": "^4.17.21"' },
          { source: "tool", toolCallId: "call-123", traceSeq: 42 },
        ],
        writtenBy: writerResearcher,
      });

      expect(entry.key).toBe("deps");
      expect(entry.version).toBe(1);
      expect(entry.status).toBe("ok");
      expect(entry.value).toEqual({ packages: ["lodash", "express"] });
      expect(entry.evidence).toHaveLength(2);
      expect(entry.evidence[1]?.toolCallId).toBe("call-123");
      expect(entry.evidence[1]?.traceSeq).toBe(42);
      expect(entry.writtenBy).toEqual(writerResearcher);
      expect(entry.ts).toBeGreaterThan(0);

      expect(bb.has("deps")).toBe(true);
      expect(bb.has("other")).toBe(false);
      expect(bb.size).toBe(1);

      const retrieved = bb.get("deps");
      expect(retrieved).toEqual(entry);
    });

    it("writes a complete pre-constructed BlackboardEntry", () => {
      const bb = new Blackboard();
      const rawEntry: BlackboardEntry = {
        key: "vulns",
        version: 1,
        status: "ok",
        value: [{ id: "GHSA-1", severity: "HIGH" }],
        evidence: [{ source: "osv", url: "https://osv.dev/GHSA-1" }],
        writtenBy: writerResearcher,
        ts: 1_700_000_000_000,
      };

      const result = bb.write(rawEntry);
      expect(result).toEqual(rawEntry);
      expect(bb.get("vulns")).toEqual(rawEntry);
    });

    it("returns undefined for get on non-existent key", () => {
      const bb = new Blackboard();
      expect(bb.get("nonexistent")).toBeUndefined();
    });

    it("throws BlackboardNotFoundError on read for non-existent key", () => {
      const bb = new Blackboard();
      expect(() => bb.read("missing")).toThrow(BlackboardNotFoundError);
      expect(() => bb.read("missing")).toThrow(/Blackboard entry for key "missing" not found/);
    });

    it("uses custom clock when provided", () => {
      let now = 1000;
      const bb = new Blackboard({ clock: () => now });
      const e1 = bb.write({
        key: "k1",
        value: 1,
        evidence: [{ source: "s1" }],
        writtenBy: writerResearcher,
      });
      expect(e1.ts).toBe(1000);

      now = 2000;
      const e2 = bb.write({
        key: "k2",
        value: 2,
        evidence: [{ source: "s2" }],
        writtenBy: writerResearcher,
      });
      expect(e2.ts).toBe(2000);
    });

    it("rejects invalid entry shape that fails BlackboardEntry validation", () => {
      const bb = new Blackboard();
      expect(() =>
        bb.write({
          key: "bad",
          value: "test",
          // @ts-expect-error invalid evidence shape
          evidence: "not-an-array",
          writtenBy: writerResearcher,
        }),
      ).toThrow(BlackboardValidationError);
    });
  });

  describe("versioning and history", () => {
    it("allows sequential new versions with previous versions retained", () => {
      const bb = new Blackboard();

      const v1 = bb.write({
        key: "report",
        value: { findings: ["f1"] },
        evidence: [{ source: "audit" }],
        writtenBy: writerResearcher,
      });
      expect(v1.version).toBe(1);

      const v2 = bb.write({
        key: "report",
        version: 2,
        value: { findings: ["f1", "f2"] },
        evidence: [{ source: "audit-v2" }],
        writtenBy: writerExecutor,
      });
      expect(v2.version).toBe(2);

      const v3 = bb.writeNewVersion({
        key: "report",
        value: { findings: ["f1", "f2", "f3"] },
        evidence: [{ source: "audit-v3" }],
        writtenBy: writerExecutor,
      });
      expect(v3.version).toBe(3);

      // Latest version is v3
      expect(bb.get("report")?.version).toBe(3);
      expect(bb.read("report").value).toEqual({ findings: ["f1", "f2", "f3"] });

      // Previous versions are retained and readable
      expect(bb.getVersion("report", 1)?.value).toEqual({ findings: ["f1"] });
      expect(bb.getVersion("report", 2)?.value).toEqual({ findings: ["f1", "f2"] });
      expect(bb.getVersion("report", 3)?.value).toEqual({ findings: ["f1", "f2", "f3"] });
      expect(bb.getVersion("report", 4)).toBeUndefined();

      // Full history for the key
      const history = bb.getHistory("report");
      expect(history).toHaveLength(3);
      expect(history.map((h) => h.version)).toEqual([1, 2, 3]);
      expect(history[0]?.writtenBy.role).toBe("researcher");
      expect(history[1]?.writtenBy.role).toBe("executor");
    });

    it("writeNewVersion creates version 1 if key is new", () => {
      const bb = new Blackboard();
      const entry = bb.writeNewVersion({
        key: "new_key",
        value: "first",
        evidence: [{ source: "test" }],
        writtenBy: writerResearcher,
      });
      expect(entry.version).toBe(1);
      expect(bb.get("new_key")?.version).toBe(1);
    });

    it("getHistory returns empty array for non-existent key", () => {
      const bb = new Blackboard();
      expect(bb.getHistory("missing")).toEqual([]);
    });
  });

  describe("refusal to overwrite", () => {
    it("refuses second write to an existing key without specifying a new version", () => {
      const bb = new Blackboard();
      bb.write({
        key: "findings",
        value: "v1",
        evidence: [{ source: "test" }],
        writtenBy: writerResearcher,
      });

      expect(() =>
        bb.write({
          key: "findings",
          value: "v2-attempted-overwrite",
          evidence: [{ source: "test" }],
          writtenBy: writerResearcher,
        }),
      ).toThrow(BlackboardOverwriteError);
    });

    it("refuses write with the same version as current", () => {
      const bb = new Blackboard();
      bb.write({
        key: "findings",
        version: 1,
        value: "v1",
        evidence: [{ source: "test" }],
        writtenBy: writerResearcher,
      });

      expect(() =>
        bb.write({
          key: "findings",
          version: 1,
          value: "v1-overwrite",
          evidence: [{ source: "test" }],
          writtenBy: writerResearcher,
        }),
      ).toThrow(BlackboardOverwriteError);
    });

    it("refuses write with a lower version than current", () => {
      const bb = new Blackboard();
      bb.write({
        key: "findings",
        value: "v1",
        evidence: [{ source: "test" }],
        writtenBy: writerResearcher,
      });
      bb.write({
        key: "findings",
        version: 2,
        value: "v2",
        evidence: [{ source: "test" }],
        writtenBy: writerResearcher,
      });

      expect(() =>
        bb.write({
          key: "findings",
          version: 1,
          value: "v1-stale",
          evidence: [{ source: "test" }],
          writtenBy: writerResearcher,
        }),
      ).toThrow(BlackboardOverwriteError);
    });

    it("refuses write with non-sequential version jump", () => {
      const bb = new Blackboard();
      bb.write({
        key: "findings",
        value: "v1",
        evidence: [{ source: "test" }],
        writtenBy: writerResearcher,
      });

      expect(() =>
        bb.write({
          key: "findings",
          version: 3,
          value: "v3-jumped",
          evidence: [{ source: "test" }],
          writtenBy: writerResearcher,
        }),
      ).toThrow(BlackboardError);
    });

    it("refuses initial write with version > 1", () => {
      const bb = new Blackboard();
      expect(() =>
        bb.write({
          key: "findings",
          version: 2,
          value: "v2-initial",
          evidence: [{ source: "test" }],
          writtenBy: writerResearcher,
        }),
      ).toThrow(BlackboardError);
    });

    it("includes key and currentVersion in BlackboardOverwriteError", () => {
      const bb = new Blackboard();
      bb.write({
        key: "my_key",
        value: "initial",
        evidence: [{ source: "test" }],
        writtenBy: writerResearcher,
      });

      try {
        bb.write({
          key: "my_key",
          version: 1,
          value: "overwrite",
          evidence: [{ source: "test" }],
          writtenBy: writerResearcher,
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BlackboardOverwriteError);
        const oe = err as BlackboardOverwriteError;
        expect(oe.key).toBe("my_key");
        expect(oe.currentVersion).toBe(1);
        expect(oe.attemptedVersion).toBe(1);
      }
    });
  });

  describe("immutable snapshots per write", () => {
    it("creates a snapshot on each write that captures state at that moment", () => {
      const bb = new Blackboard();
      expect(bb.snapshots).toHaveLength(0);
      expect(bb.latestSnapshot).toBeUndefined();

      // Empty snapshot before any writes
      const emptySnap = bb.snapshot();
      expect(emptySnap.seq).toBe(0);
      expect(emptySnap.list()).toHaveLength(0);

      // Write 1
      const e1 = bb.write({
        key: "k1",
        value: "val1",
        evidence: [{ source: "s1" }],
        writtenBy: writerResearcher,
      });
      expect(bb.snapshots).toHaveLength(1);
      const snap1 = bb.latestSnapshot!;
      expect(snap1.seq).toBe(1);
      expect(snap1.triggeredBy).toEqual(e1);
      expect(snap1.keys()).toEqual(["k1"]);
      expect(snap1.get("k1")?.value).toBe("val1");

      // Write 2 (new key)
      const e2 = bb.write({
        key: "k2",
        value: "val2",
        evidence: [{ source: "s2" }],
        writtenBy: writerResearcher,
      });
      expect(bb.snapshots).toHaveLength(2);
      const snap2 = bb.latestSnapshot!;
      expect(snap2.seq).toBe(2);
      expect(snap2.triggeredBy).toEqual(e2);
      expect(snap2.keys().sort()).toEqual(["k1", "k2"]);

      // Write 3 (new version of k1)
      const e3 = bb.writeNewVersion({
        key: "k1",
        value: "val1-updated",
        evidence: [{ source: "s3" }],
        writtenBy: writerExecutor,
      });
      expect(bb.snapshots).toHaveLength(3);
      const snap3 = bb.latestSnapshot!;
      expect(snap3.seq).toBe(3);
      expect(snap3.triggeredBy).toEqual(e3);

      // Assert snapshot isolation: snap1 and snap2 are completely unchanged!
      expect(snap1.keys()).toEqual(["k1"]);
      expect(snap1.get("k1")?.value).toBe("val1");
      expect(snap1.get("k1")?.version).toBe(1);
      expect(snap1.has("k2")).toBe(false);

      expect(snap2.get("k1")?.value).toBe("val1");
      expect(snap2.get("k1")?.version).toBe(1);
      expect(snap2.get("k2")?.value).toBe("val2");

      expect(snap3.get("k1")?.value).toBe("val1-updated");
      expect(snap3.get("k1")?.version).toBe(2);
      expect(snap3.get("k2")?.value).toBe("val2");

      // Retrieve snapshot by seq
      expect(bb.getSnapshot(1)).toBe(snap1);
      expect(bb.getSnapshot(2)).toBe(snap2);
      expect(bb.getSnapshot(3)).toBe(snap3);
      expect(bb.getSnapshot(999)).toBeUndefined();
    });

    it("freezes snapshot entries against mutation", () => {
      const bb = new Blackboard();
      bb.write({
        key: "k",
        value: { foo: "bar" },
        evidence: [{ source: "s" }],
        writtenBy: writerResearcher,
      });

      const snap = bb.latestSnapshot!;
      const entry = snap.get("k")!;
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(snap)).toBe(true);

      expect(() => {
        (entry as { status: string }).status = "degraded";
      }).toThrow();
    });

    it("provides snapshot helper methods: read, getAll, inputs, toJSON", () => {
      const bb = new Blackboard();
      bb.write({
        key: "deps",
        value: ["a", "b"],
        evidence: [{ source: "s1" }],
        writtenBy: writerResearcher,
      });
      bb.write({
        key: "vulns",
        value: [1],
        evidence: [{ source: "s2" }],
        writtenBy: writerResearcher,
      });

      const snap = bb.latestSnapshot!;
      expect(snap.read("deps").value).toEqual(["a", "b"]);
      expect(() => snap.read("missing")).toThrow(BlackboardNotFoundError);

      expect(snap.getAll()).toEqual({
        deps: snap.get("deps"),
        vulns: snap.get("vulns"),
      });

      const inputs = snap.inputs(["deps"]);
      expect(inputs).toEqual({ deps: snap.get("deps") });

      const json = snap.toJSON();
      expect(json.seq).toBe(2);
      expect(json.entries.deps).toBeDefined();
    });
  });

  describe("degraded entries", () => {
    it("supports status: 'degraded' entries via write and writeDegraded", () => {
      const bb = new Blackboard();

      const degraded1 = bb.write({
        key: "advisories",
        status: "degraded",
        value: { error: "upstream timeout", partial: [] },
        evidence: [{ source: "osv-504" }],
        writtenBy: writerResearcher,
      });
      expect(degraded1.status).toBe("degraded");
      expect(bb.get("advisories")?.status).toBe("degraded");

      const degraded2 = bb.writeDegraded({
        key: "npm_meta",
        value: { reason: "404 not found" },
        evidence: [{ source: "npm" }],
        writtenBy: writerResearcher,
      });
      expect(degraded2.status).toBe("degraded");
      expect(bb.get("npm_meta")?.status).toBe("degraded");

      const okEntry = bb.write({
        key: "deps",
        value: ["express"],
        evidence: [{ source: "package.json" }],
        writtenBy: writerResearcher,
      });
      expect(okEntry.status).toBe("ok");

      // Filtering degraded entries
      const degradedList = bb.list({ status: "degraded" });
      expect(degradedList).toHaveLength(2);
      expect(degradedList.map((d) => d.key).sort()).toEqual(["advisories", "npm_meta"]);

      const okList = bb.list({ status: "ok" });
      expect(okList).toHaveLength(1);
      expect(okList[0]?.key).toBe("deps");
    });
  });

  describe("schema validation on read", () => {
    const DepSchema = z.object({
      name: z.string(),
      version: z.string(),
    });

    it("validates entry value successfully on get and read", () => {
      const bb = new Blackboard();
      bb.write({
        key: "dep",
        value: { name: "react", version: "18.2.0" },
        evidence: [{ source: "pkg" }],
        writtenBy: writerResearcher,
      });

      const entry = bb.get("dep", DepSchema);
      expect(entry).toBeDefined();
      expect(entry?.value.name).toBe("react");
      expect(entry?.value.version).toBe("18.2.0");

      const readEntry = bb.read("dep", DepSchema);
      expect(readEntry.value.name).toBe("react");
    });

    it("throws BlackboardValidationError when entry value fails schema on get or read", () => {
      const bb = new Blackboard();
      bb.write({
        key: "dep",
        value: { name: "react", version: 123 }, // version is number, expected string
        evidence: [{ source: "pkg" }],
        writtenBy: writerResearcher,
      });

      expect(() => bb.get("dep", DepSchema)).toThrow(BlackboardValidationError);
      expect(() => bb.read("dep", DepSchema)).toThrow(BlackboardValidationError);

      try {
        bb.read("dep", DepSchema);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BlackboardValidationError);
        const ve = err as BlackboardValidationError;
        expect(ve.key).toBe("dep");
        expect(ve.version).toBe(1);
        expect(ve.zodError).toBeDefined();
      }
    });

    it("validates schema on specific versions with getVersion", () => {
      const bb = new Blackboard();
      bb.write({
        key: "k",
        value: { name: "valid", version: "1.0" },
        evidence: [{ source: "s" }],
        writtenBy: writerResearcher,
      });
      bb.writeNewVersion({
        key: "k",
        value: { name: "invalid", version: 99 },
        evidence: [{ source: "s" }],
        writtenBy: writerResearcher,
      });

      expect(bb.getVersion("k", 1, DepSchema)?.value.name).toBe("valid");
      expect(() => bb.getVersion("k", 2, DepSchema)).toThrow(BlackboardValidationError);
    });

    it("validates schema in snapshot get and read", () => {
      const bb = new Blackboard();
      bb.write({
        key: "dep",
        value: { name: "lodash", version: "4.17.21" },
        evidence: [{ source: "pkg" }],
        writtenBy: writerResearcher,
      });

      const snap = bb.latestSnapshot!;
      expect(snap.get("dep", DepSchema)?.value.name).toBe("lodash");
      expect(snap.read("dep", DepSchema).value.version).toBe("4.17.21");

      const WrongSchema = z.object({ requiredField: z.number() });
      expect(() => snap.get("dep", WrongSchema)).toThrow(BlackboardValidationError);
      expect(() => snap.read("dep", WrongSchema)).toThrow(BlackboardValidationError);
    });
  });

  describe("listing API", () => {
    it("lists latest entries and applies filters", () => {
      const bb = new Blackboard();

      bb.write({
        key: "k1",
        value: 1,
        evidence: [{ source: "s" }],
        writtenBy: writerResearcher,
      });
      bb.write({
        key: "k2",
        value: 2,
        evidence: [{ source: "s" }],
        writtenBy: writerExecutor,
      });
      bb.write({
        key: "k3",
        status: "degraded",
        value: null,
        evidence: [{ source: "s" }],
        writtenBy: writerResearcher,
      });

      expect(bb.listKeys().sort()).toEqual(["k1", "k2", "k3"]);
      expect(bb.list()).toHaveLength(3);

      // Filter by role
      const researcherEntries = bb.list({ role: "researcher" });
      expect(researcherEntries.map((e) => e.key).sort()).toEqual(["k1", "k3"]);

      // Filter by agentId
      const executorEntries = bb.list({ agentId: "agent-2" });
      expect(executorEntries.map((e) => e.key)).toEqual(["k2"]);

      // Filter by subtaskId
      const task1Entries = bb.list({ subtaskId: "task-1" });
      expect(task1Entries.map((e) => e.key).sort()).toEqual(["k1", "k3"]);

      // Filter by status and role
      const degradedResearcher = bb.list({ status: "degraded", role: "researcher" });
      expect(degradedResearcher.map((e) => e.key)).toEqual(["k3"]);
    });

    it("returns chronological write history via listHistory", () => {
      const bb = new Blackboard();
      bb.write({ key: "k1", value: 1, evidence: [{ source: "s" }], writtenBy: writerResearcher });
      bb.write({ key: "k2", value: 1, evidence: [{ source: "s" }], writtenBy: writerResearcher });
      bb.writeNewVersion({
        key: "k1",
        value: 2,
        evidence: [{ source: "s" }],
        writtenBy: writerExecutor,
      });

      const allHistory = bb.listHistory();
      expect(allHistory).toHaveLength(3);
      expect(allHistory[0]?.key).toBe("k1");
      expect(allHistory[0]?.version).toBe(1);
      expect(allHistory[1]?.key).toBe("k2");
      expect(allHistory[1]?.version).toBe(1);
      expect(allHistory[2]?.key).toBe("k1");
      expect(allHistory[2]?.version).toBe(2);

      const k1History = bb.listHistory("k1");
      expect(k1History).toHaveLength(2);
      expect(k1History.map((h) => h.version)).toEqual([1, 2]);
    });

    it("returns getAll mapping each key to its latest entry", () => {
      const bb = new Blackboard();
      bb.write({ key: "a", value: 1, evidence: [{ source: "s" }], writtenBy: writerResearcher });
      bb.write({ key: "b", value: 2, evidence: [{ source: "s" }], writtenBy: writerResearcher });
      bb.writeNewVersion({
        key: "a",
        value: 10,
        evidence: [{ source: "s" }],
        writtenBy: writerExecutor,
      });

      const all = bb.getAll();
      expect(Object.keys(all).sort()).toEqual(["a", "b"]);
      expect(all.a?.version).toBe(2);
      expect(all.a?.value).toBe(10);
      expect(all.b?.version).toBe(1);
    });
  });

  describe("handoff packet inputs subset (plan.md 2.4 inputs)", () => {
    it("returns the exact subset of entries requested by key array", () => {
      const bb = new Blackboard();
      const eDeps = bb.write({
        key: "deps",
        value: ["lodash"],
        evidence: [{ source: "pkg" }],
        writtenBy: writerResearcher,
      });
      const eVulns = bb.write({
        key: "vulns",
        value: [{ id: "V1" }],
        evidence: [{ source: "osv" }],
        writtenBy: writerResearcher,
      });
      bb.write({
        key: "unrelated",
        value: "ignore me",
        evidence: [{ source: "other" }],
        writtenBy: writerResearcher,
      });

      const inputs = bb.getInputs(["deps", "vulns"]);
      expect(Object.keys(inputs).sort()).toEqual(["deps", "vulns"]);
      expect(inputs.deps).toEqual(eDeps);
      expect(inputs.vulns).toEqual(eVulns);
      expect(inputs.unrelated).toBeUndefined();
    });

    it("works with a Subtask-like object containing inputKeys", () => {
      const bb = new Blackboard();
      const entry = bb.write({
        key: "inventory",
        value: { count: 5 },
        evidence: [{ source: "npm" }],
        writtenBy: writerResearcher,
      });

      const subtask = {
        id: "task-2",
        title: "Triage",
        description: "Assess vulns",
        dependsOn: ["task-1"],
        roleHint: "executor" as const,
        output: { key: "report" },
        inputKeys: ["inventory"],
      };

      const result = bb.inputs(subtask);
      expect(result).toEqual({ inventory: entry });
    });

    it("throws BlackboardNotFoundError if a required input key is missing", () => {
      const bb = new Blackboard();
      bb.write({
        key: "deps",
        value: ["lodash"],
        evidence: [{ source: "pkg" }],
        writtenBy: writerResearcher,
      });

      expect(() => bb.getInputs(["deps", "missingKey"])).toThrow(BlackboardNotFoundError);
      expect(() => bb.getInputs(["deps", "missingKey"])).toThrow(/missingKey/);
    });

    it("omits missing keys when allowMissing: true is specified", () => {
      const bb = new Blackboard();
      const entry = bb.write({
        key: "deps",
        value: ["lodash"],
        evidence: [{ source: "pkg" }],
        writtenBy: writerResearcher,
      });

      const inputs = bb.getInputs(["deps", "missingKey"], { allowMissing: true });
      expect(Object.keys(inputs)).toEqual(["deps"]);
      expect(inputs.deps).toEqual(entry);
    });

    it("provides inputs subset via snapshot.inputs", () => {
      const bb = new Blackboard();
      const e1 = bb.write({
        key: "k1",
        value: "v1",
        evidence: [{ source: "s" }],
        writtenBy: writerResearcher,
      });
      const snap = bb.latestSnapshot!;
      expect(snap.inputs(["k1"])).toEqual({ k1: e1 });
      expect(() => snap.inputs(["missing"])).toThrow(BlackboardNotFoundError);
      expect(snap.inputs(["missing"], { allowMissing: true })).toEqual({});
    });
  });

  describe("trace event emission (blackboard.written)", () => {
    it("emits valid blackboard.written event to a callback trace sink", () => {
      const emitted: TraceEvent[] = [];
      const sink: TraceSink = (event) => {
        emitted.push(event);
      };

      const bb = new Blackboard({
        runId: "run-42",
        traceSink: sink,
        clock: () => 1_700_000_123_000,
      });

      const entry1 = bb.write({
        key: "vulns",
        value: { count: 3 },
        evidence: [{ source: "osv", toolCallId: "call-1" }],
        writtenBy: writerResearcher,
      });

      const entry2 = bb.writeNewVersion({
        key: "vulns",
        value: { count: 4 },
        evidence: [{ source: "osv", traceSeq: 10 }],
        writtenBy: writerResearcher,
      });

      expect(emitted).toHaveLength(2);

      // Verify event 1
      const ev1 = emitted[0]!;
      expect(ev1.kind).toBe("blackboard.written");
      expect(ev1.runId).toBe("run-42");
      expect(ev1.seq).toBe(0);
      expect(ev1.ts).toBe(1_700_000_123_000);
      if (ev1.kind === "blackboard.written") {
        expect(ev1.key).toBe("vulns");
        expect(ev1.entry).toEqual(entry1);
      }

      // Verify event 2
      const ev2 = emitted[1]!;
      expect(ev2.kind).toBe("blackboard.written");
      expect(ev2.runId).toBe("run-42");
      expect(ev2.seq).toBe(1);
      if (ev2.kind === "blackboard.written") {
        expect(ev2.key).toBe("vulns");
        expect(ev2.entry).toEqual(entry2);
      }

      // Verify events pass TraceEvent schema parser
      for (const ev of emitted) {
        expect(() => TraceEvent.parse(ev)).not.toThrow();
      }
    });

    it("emits to an object sink with .emit method", () => {
      const emitted: TraceEvent[] = [];
      const sink = {
        emit: (event: TraceEvent) => {
          emitted.push(event);
        },
      };

      const bb = new Blackboard({ runId: "run-obj", traceSink: sink });
      bb.write({
        key: "test",
        value: 123,
        evidence: [{ source: "s" }],
        writtenBy: writerResearcher,
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.kind).toBe("blackboard.written");
    });

    it("emits to an object sink with .write method", () => {
      const emitted: TraceEvent[] = [];
      const sink = {
        write: (event: TraceEvent) => {
          emitted.push(event);
        },
      };

      const bb = new Blackboard({ runId: "run-write", traceSink: sink });
      bb.write({
        key: "test",
        value: "hello",
        evidence: [{ source: "s" }],
        writtenBy: writerResearcher,
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.kind).toBe("blackboard.written");
    });

    it("works normally when no trace sink is provided", () => {
      const bb = new Blackboard();
      expect(() => {
        bb.write({
          key: "k",
          value: "v",
          evidence: [{ source: "s" }],
          writtenBy: writerResearcher,
        });
      }).not.toThrow();
      expect(bb.get("k")?.value).toBe("v");
    });
  });
});
