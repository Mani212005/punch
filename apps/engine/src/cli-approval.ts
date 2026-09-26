import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import readline from "readline";
import { type ApprovalDecision, type ApprovalRequest, CallbackApprovalGate } from "@punch/core";

export function createCliApprovalGate(runsDir: string, runId: string): CallbackApprovalGate {
  return new CallbackApprovalGate(async (request: ApprovalRequest) => {
    const approvalsDir = path.join(runsDir, runId, "approvals");
    await fs.mkdir(approvalsDir, { recursive: true });

    const requestFile = path.join(approvalsDir, `${request.approvalId}.request.json`);
    const decisionFile = path.join(approvalsDir, `${request.approvalId}.decision.json`);

    await fs.writeFile(requestFile, JSON.stringify(request, null, 2), "utf-8");

    return new Promise<ApprovalDecision>((resolve) => {
      let resolved = false;
      let rl: readline.Interface | null = null;
      let watcher: fsSync.FSWatcher | null = null;

      let cleanup = () => {
        resolved = true;
        if (rl) rl.close();
        if (watcher) watcher.close();
      };

      const finish = async (decision: ApprovalDecision) => {
        if (resolved) return;
        cleanup();
        // optionally clean up the request file
        await fs.unlink(requestFile).catch(() => {});
        resolve(decision);
      };

      // Watch for the decision file
      try {
        watcher = fsSync.watch(approvalsDir, async (eventType, filename) => {
          if (filename === `${request.approvalId}.decision.json`) {
            try {
              const content = await fs.readFile(decisionFile, "utf-8");
              const decision = JSON.parse(content) as ApprovalDecision;
              await finish(decision);
            } catch {
              // Ignore partial reads or errors
            }
          }
        });
      } catch {
        // Fallback to polling if watch fails
        const interval = setInterval(async () => {
          if (resolved) {
            clearInterval(interval);
            return;
          }
          try {
            const content = await fs.readFile(decisionFile, "utf-8");
            const decision = JSON.parse(content) as ApprovalDecision;
            clearInterval(interval);
            await finish(decision);
          } catch {
            // Ignore
          }
        }, 500);
        const originalCleanup = cleanup;
        cleanup = () => {
          originalCleanup();
          clearInterval(interval);
        };
      }

      // Interactive prompt if TTY
      if (process.stdout.isTTY && process.stdin.isTTY) {
        const payloadStr = JSON.stringify(request.payload, null, 2);
        console.log(`\n=========================================`);
        console.log(`APPROVAL REQUESTED: ${request.tool}`);
        console.log(`Payload: ${payloadStr}`);
        console.log(`Run: ${runId} | Approval ID: ${request.approvalId}`);
        console.log(`=========================================`);
        
        rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const ask = () => {
          if (resolved) return;
          rl!.question("Approve this action? [y/N]: ", async (answer) => {
            if (resolved) return;
            const normalized = answer.trim().toLowerCase();
            if (normalized === "y" || normalized === "yes") {
              await finish({ approved: true, decidedBy: "cli-prompt" });
            } else if (normalized === "n" || normalized === "no" || normalized === "") {
              await finish({ approved: false, decidedBy: "cli-prompt", reason: "denied via CLI prompt" });
            } else {
              console.log("Please enter 'y' or 'n'.");
              ask();
            }
          });
        };
        ask();
      } else {
        console.log(`\n[Approval required] Tool: ${request.tool} | Run: ${runId} | ID: ${request.approvalId}`);
        console.log(`Run 'punch approve ${runId} ${request.approvalId}' in another terminal.`);
      }
    });
  });
}
