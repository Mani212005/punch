import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TraceEvent } from "@punch/shared";
import { createInitialBoardState, traceReducer } from "@/lib/trace";
import { findInvestigationReport } from "@/lib/trace/investigation";
import ApprovalCardTile from "../watch/components/ApprovalCardTile";
import EvidenceLedgerTile from "../watch/components/EvidenceLedgerTile";
import InvestigationReportTile from "../watch/components/InvestigationReportTile";
import SandboxTile from "../watch/components/SandboxTile";

const events = readFileSync(resolve(__dirname, "../../../../traces/investigation.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => TraceEvent.parse(JSON.parse(l)));

function stateAt(kind: TraceEvent["kind"] | null) {
  const cut = kind ? events.findIndex((e) => e.kind === kind) + 1 : events.length;
  return events.slice(0, cut).reduce(traceReducer, createInitialBoardState());
}

describe("investigation views render from the committed trace", () => {
  it("renders the section-8 report with reachability, impact, sandbox and critic", () => {
    const s = stateAt(null);
    render(<InvestigationReportTile blackboard={s.blackboard} criticVerdicts={s.criticVerdicts} />);
    expect(screen.getByText("REACHABLE")).toBeInTheDocument();
    expect(screen.getByText("NOT_REACHABLE")).toBeInTheDocument();
    expect(screen.getByText("UPGRADE")).toBeInTheDocument();
    expect(screen.getByText("NOT RUN")).toBeInTheDocument();
    expect(screen.getAllByText("ACCEPTED")).toHaveLength(2);
  });

  it("shows supply-chain signals beside a finding that has them", () => {
    const s = stateAt(null);
    const report = findInvestigationReport(s.blackboard)!;
    report.findings[0]!.supplyChain = [
      {
        kind: "install_script",
        severity: "HIGH",
        detail: "postinstall runs curl",
        version: report.findings[0]!.version,
      },
    ];
    render(
      <InvestigationReportTile
        blackboard={{ report: { key: "report", value: report } as never }}
        criticVerdicts={s.criticVerdicts}
      />,
    );
    const box = screen.getByTestId(`supply-chain-${report.findings[0]!.id}`);
    expect(box).toHaveTextContent("install script");
    expect(box).toHaveTextContent("postinstall runs curl");
    expect(screen.queryAllByText("supply-chain signals")).toHaveLength(1);
  });

  it("drills into a claim to show who claimed it and the verifier", () => {
    const s = stateAt(null);
    render(<EvidenceLedgerTile claims={s.claims} evidence={s.evidence} logs={s.logs.entries} />);
    fireEvent.click(screen.getByText(/GET \/orders is a public route/));
    expect(screen.getByLabelText("Claim c-6 evidence")).toBeInTheDocument();
    expect(screen.getByLabelText("Claim c-6 evidence").textContent).toMatch(/reachability/);
  });

  it("renders baseline vs candidate sandbox results", () => {
    const s = stateAt(null);
    render(<SandboxTile sandboxRuns={s.sandbox} />);
    expect(screen.getAllByText(/tests 48\/48 pass/)).toHaveLength(2);
  });

  it("shows a pending approval with a yellow border", () => {
    const s = stateAt("approval.requested");
    render(
      <ApprovalCardTile
        remediations={s.remediations}
        approvals={s.approvals}
        sandboxRuns={s.sandbox}
        report={findInvestigationReport(s.blackboard)}
      />,
    );
    const card = screen.getByTestId("remediation-f-1");
    expect(card.style.borderColor).toBe("var(--bz-yellow)");
  });
});
