
import type {
  Claim,
  ClaimActor,
  EvidenceRecord,
  TraceEvent,
  SlotRole,
} from "@punch/shared";

import type { TraceSink } from "../blackboard.js";

export class EvidenceLedger {
  private claims = new Map<string, Claim>();
  private evidence = new Map<string, EvidenceRecord>();
  // Track who emitted which evidence for handoff
  private evidenceByAuthor = new Map<string, Set<string>>(); // agentId or role -> evidence id
  private evidenceBySubtask = new Map<string, Set<string>>(); // subtaskId -> evidence id

  constructor(
    private readonly runId: string,
    private readonly traceSink?: TraceSink,
    private now: () => number = () => Date.now(),
    private seqRef: { seq: number } = { seq: 0 },
  ) {}

  ingest(event: TraceEvent): void {
    if (event.kind === "evidence.recorded") {
      this.evidence.set(event.evidence.id, event.evidence);
      const authorKey = event.agentId || event.role;
      if (!this.evidenceByAuthor.has(authorKey)) {
        this.evidenceByAuthor.set(authorKey, new Set());
      }
      this.evidenceByAuthor.get(authorKey)!.add(event.evidence.id);

      if (event.subtaskId) {
        if (!this.evidenceBySubtask.has(event.subtaskId)) {
          this.evidenceBySubtask.set(event.subtaskId, new Set());
        }
        this.evidenceBySubtask.get(event.subtaskId)!.add(event.evidence.id);
      }
    } else if (event.kind === "claim.recorded") {
      this.claims.set(event.claim.id, event.claim);
    } else if (event.kind === "claim.verified") {
      const claim = this.claims.get(event.claimId);
      if (claim) {
        claim.status = "verified";
        claim.verifier = event.verifier;
        claim.rationale = event.rationale;
      }
    } else if (event.kind === "claim.refuted") {
      const claim = this.claims.get(event.claimId);
      if (claim) {
        claim.status = "refuted";
        claim.verifier = event.verifier;
        claim.rationale = event.rationale;
      }
    }
  }

  getClaim(id: string): Claim | undefined {
    return this.claims.get(id);
  }

  getEvidence(id: string): EvidenceRecord | undefined {
    return this.evidence.get(id);
  }

  getClaimsByFinding(findingId: string): Claim[] {
    return Array.from(this.claims.values()).filter((c) => c.findingId === findingId);
  }

  getClaimsByAuthor(agentId: string): Claim[] {
    return Array.from(this.claims.values()).filter((c) => c.author.agentId === agentId);
  }

  getClaimsByVerifier(agentId: string): Claim[] {
    return Array.from(this.claims.values()).filter(
      (c) => c.verifier && c.verifier.agentId === agentId,
    );
  }

  getHandoffEvidence(subtaskId: string): EvidenceRecord[] {
    const ids = this.evidenceBySubtask.get(subtaskId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.evidence.get(id))
      .filter((e): e is EvidenceRecord => e !== undefined);
  }

  getAllClaims(): Claim[] {
    return Array.from(this.claims.values());
  }

  getAllEvidence(): EvidenceRecord[] {
    return Array.from(this.evidence.values());
  }

  recordEvidence(
    author: { role: SlotRole | "validator"; agentId?: string; subtaskId?: string },
    evidence: EvidenceRecord,
  ): EvidenceRecord {
    const event: TraceEvent = {
      kind: "evidence.recorded",
      runId: this.runId,
      ts: this.now(),
      seq: this.seqRef.seq++,
      role: author.role,
      agentId: author.agentId,
      subtaskId: author.subtaskId,
      evidence,
    };
    this.ingest(event);
    this.emit(event);
    return evidence;
  }

  recordClaim(claim: Claim): Claim {
    const event: TraceEvent = {
      kind: "claim.recorded",
      runId: this.runId,
      ts: this.now(),
      seq: this.seqRef.seq++,
      claim,
    };
    this.ingest(event);
    this.emit(event);
    return claim;
  }

  verifyClaim(claimId: string, verifier: ClaimActor, rationale?: string): void {
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`Claim not found: ${claimId}`);

    const event: TraceEvent = {
      kind: "claim.verified",
      runId: this.runId,
      ts: this.now(),
      seq: this.seqRef.seq++,
      claimId,
      verifier,
      rationale,
    };
    this.ingest(event);
    this.emit(event);
  }

  refuteClaim(claimId: string, verifier: ClaimActor, rationale: string): void {
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`Claim not found: ${claimId}`);

    const event: TraceEvent = {
      kind: "claim.refuted",
      runId: this.runId,
      ts: this.now(),
      seq: this.seqRef.seq++,
      claimId,
      verifier,
      rationale,
    };
    this.ingest(event);
    this.emit(event);
  }

  private emit(event: TraceEvent) {
    if (!this.traceSink) return;
    if (typeof this.traceSink === "function") {
      void this.traceSink(event);
    } else if ("emit" in this.traceSink && typeof this.traceSink.emit === "function") {
      void this.traceSink.emit(event);
    } else if ("write" in this.traceSink && typeof this.traceSink.write === "function") {
      void this.traceSink.write(event);
    }
  }
}

export * from "./report.js";
