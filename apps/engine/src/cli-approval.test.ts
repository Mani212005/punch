import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createCliApprovalGate } from "./cli-approval.js";
import { type ApprovalDecision } from "@punch/core";

describe("CLI Approval Gate", () => {
  it("waits for decision file and resolves", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "punch-cli-approval-"));
    const runId = "test-run";
    const gate = createCliApprovalGate(tempDir, runId);
    
    const requestPromise = gate.requestApproval({
      approvalId: "test-approval",
      tool: "github_create_issue",
      payload: { owner: "Mani212005", repo: "punch", title: "Test", body: "Body" }
    });
    
    // the gate should have written the request file
    const requestFile = path.join(tempDir, runId, "approvals", "test-approval.request.json");
    // wait a moment for the promise to execute the initial mkdir and writeFile
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const reqContent = await fs.readFile(requestFile, "utf-8");
    expect(JSON.parse(reqContent).tool).toBe("github_create_issue");
    
    // write decision file
    const decisionFile = path.join(tempDir, runId, "approvals", "test-approval.decision.json");
    const decision: ApprovalDecision = { approved: true, decidedBy: "test" };
    await fs.writeFile(decisionFile, JSON.stringify(decision), "utf-8");
    
    const result = await requestPromise;
    expect(result.approved).toBe(true);
    expect(result.decidedBy).toBe("test");
    
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
