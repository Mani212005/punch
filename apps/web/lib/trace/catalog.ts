/** Committed demo traces the replay picker offers; each id is `traces/<id>.jsonl`. */
export interface DemoTrace {
  id: string;
  name: string;
  description: string;
}

export const DEMO_TRACES: readonly DemoTrace[] = [
  {
    id: "takeover",
    name: "Takeover Run",
    description:
      "A researcher is killed mid-subtask and a standby on another provider finishes it.",
  },
  {
    id: "clean",
    name: "Clean Run",
    description: "Fully automatic run, no failures: the baseline.",
  },
  {
    id: "manual",
    name: "Manual Mix",
    description:
      "Manual mode: the operator pins a different agent to each role across two providers.",
  },
  {
    id: "chaos",
    name: "Tool Chaos",
    description:
      "OSV returns 500s and npm metadata comes back empty; the run degrades instead of crashing.",
  },
  {
    id: "denial",
    name: "Denied Approval",
    description: "The executor asks to file a GitHub issue and the irreversible action is denied.",
  },
  {
    id: "investigation",
    name: "Investigation Run",
    description:
      "Security investigation with the evidence ledger, critic verdicts and sandbox validation.",
  },
];
