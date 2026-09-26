import type { InvestigationFinding } from "@punch/shared";
import type { EvidenceLedger } from "../ledger/index.js";
import type { NpmPackageMetadata } from "../tools/npm.js";
import { analyzeSupplyChain } from "./signals.js";

export type FetchNpmMetadata = (packageName: string) => Promise<NpmPackageMetadata | undefined>;

/**
 * E9 signal pass: attaches supply-chain anomaly signals to each finding, beside its CVE
 * data. Flagged signals are recorded in the ledger as evidence plus a claim; clean
 * packages and unreachable registries leave the finding untouched.
 */
export async function runSupplyChainPass(
  findings: InvestigationFinding[],
  deps: { fetchMetadata: FetchNpmMetadata; ledger?: EvidenceLedger },
): Promise<InvestigationFinding[]> {
  const cache = new Map<string, Promise<NpmPackageMetadata | undefined>>();
  const out: InvestigationFinding[] = [];
  for (const finding of findings) {
    let meta = cache.get(finding.dependency);
    if (!meta) {
      meta = deps.fetchMetadata(finding.dependency).catch(() => undefined);
      cache.set(finding.dependency, meta);
    }
    const resolved = await meta;
    const signals = resolved ? analyzeSupplyChain(resolved, { version: finding.version }) : [];
    if (signals.length === 0) {
      out.push(finding);
      continue;
    }
    const claimIds = [...finding.claimIds];
    if (deps.ledger) {
      const evidenceId = `ev-supplychain-${finding.id}`;
      deps.ledger.recordEvidence(
        { role: "researcher" },
        {
          id: evidenceId,
          kind: "api_response",
          ref: `https://registry.npmjs.org/${finding.dependency}`,
          excerpt: signals.map((s) => `${s.kind} (${s.severity}): ${s.detail}`).join("\n"),
          fetchedAt: Date.now(),
          tool: "analyze_supply_chain",
        },
      );
      const claimId = `claim-supplychain-${finding.id}`;
      deps.ledger.recordClaim({
        id: claimId,
        findingId: finding.id,
        kind: "other",
        text: `${finding.dependency}@${finding.version} shows supply-chain anomaly signals: ${signals.map((s) => s.kind).join(", ")}`,
        author: { role: "researcher" },
        evidenceRefs: [evidenceId],
        status: "proposed",
        verifier: null,
      });
      claimIds.push(claimId);
    }
    out.push({ ...finding, claimIds, supplyChain: signals });
  }
  return out;
}
