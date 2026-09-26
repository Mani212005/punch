import { describe, expect, it } from "vitest";
import { Slot, SlotTransitionError, type EventBody } from "./slot.js";

function makeSlot() {
  const events: EventBody[] = [];
  let clock = 1000;
  const slot = new Slot({
    role: "researcher",
    agentId: "a",
    provenance: "jev",
    standby: [{ agentId: "b", probability: 0.3 }],
    emit: (e) => events.push(e),
    now: () => clock,
    heartbeatSampleMs: 100,
  });
  return { slot, events, tick: (ms: number) => (clock += ms) };
}

describe("Slot", () => {
  it("announces its assignment with the standby list", () => {
    const { slot, events } = makeSlot();
    slot.announce();
    expect(events).toEqual([
      {
        kind: "slot.assigned",
        role: "researcher",
        agentId: "a",
        provenance: "jev",
        standby: [{ agentId: "b", probability: 0.3 }],
      },
    ]);
    expect(slot.state).toBe("assigned");
  });

  it("start moves to running, emits agent.started and stamps the heartbeat", () => {
    const { slot, events, tick } = makeSlot();
    tick(50);
    expect(slot.start("s1", "high")).toBe(1);
    expect(slot.state).toBe("running");
    expect(slot.lastHeartbeatAt).toBe(1050);
    expect(events[0]).toMatchObject({
      kind: "agent.started",
      subtaskId: "s1",
      attempt: 1,
      effort: "high",
    });
    expect(slot.assignment.effort).toBe("high");
  });

  it("every event beats the heartbeat; the trace keeps a sample", () => {
    const { slot, events, tick } = makeSlot();
    slot.start("s1");
    events.length = 0;
    tick(10);
    slot.beat("s1");
    tick(10);
    slot.beat("s1");
    expect(slot.lastHeartbeatAt).toBe(1020);
    expect(events.filter((e) => e.kind === "agent.heartbeat")).toHaveLength(1);
    tick(200);
    slot.beat("s1");
    expect(events.filter((e) => e.kind === "agent.heartbeat")).toHaveLength(2);
  });

  it("completes only when its last active subtask is done", () => {
    const { slot } = makeSlot();
    slot.start("s1");
    slot.start("s2");
    slot.complete("s1");
    expect(slot.state).toBe("running");
    slot.complete("s2");
    expect(slot.state).toBe("completed");
    slot.start("s3");
    expect(slot.state).toBe("running");
  });

  it("fail and reject emit their events and leave the slot restartable", () => {
    const { slot, events } = makeSlot();
    slot.start("s1");
    slot.fail("s1", { kind: "failed", detail: "boom" }, "permanent");
    expect(slot.state).toBe("failed");
    expect(events.at(-1)).toMatchObject({ kind: "slot.failed", classification: "permanent" });
    slot.start("s2");
    slot.reject("s2", 2, [{ claim: "c", problem: "p", severity: "blocker" }]);
    expect(slot.state).toBe("rejected");
    expect(events.at(-1)).toMatchObject({ kind: "slot.rejected", rejections: 2 });
  });

  it("rejects illegal transitions", () => {
    const { slot } = makeSlot();
    expect(() => slot.transition("completed")).toThrow(SlotTransitionError);
    expect(() => slot.transition("degraded")).toThrow(SlotTransitionError);
  });

  it("replaceAgent is the supervisor's hook: old agent goes on the replaced stack", () => {
    const { slot } = makeSlot();
    slot.start("s1");
    slot.noteTurn(0.25);
    slot.noteTurn(0.25);
    slot.fail("s1", { kind: "failed", detail: "x" });
    slot.replaceAgent({ agentId: "b", provenance: "standby" }, { kind: "failed", detail: "x" });
    expect(slot.state).toBe("replacing");
    expect(slot.agentId).toBe("b");
    expect(slot.replaced).toMatchObject([{ agentId: "a", turnsUsed: 2, usdUsed: 0.5 }]);
    expect(slot.turnsUsed).toBe(0);
    slot.start("s1");
    expect(slot.state).toBe("running");
  });
});
