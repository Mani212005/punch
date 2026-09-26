import type { BlackboardEntry, Finding } from "@punch/shared";
import type { CriticVerdict } from "./critic.js";
import type { Draft, Revision } from "./common.js";

export const DEFAULT_MAX_REJECTIONS = 2;

export interface ReviewLoopOptions {
  /** Produces a draft; receives the critic's findings and the rejected draft for a revision turn. */
  produce: (revision?: Revision) => Promise<Draft>;
  review: (draft: Draft, attempt: number) => Promise<CriticVerdict>;
  /** Writes the accepted draft to the blackboard. Nothing rejected is ever written. */
  commit: (draft: Draft) => BlackboardEntry;
  /** Critic rejections per subtask before the slot is `rejected`. Default 2. */
  maxRejections?: number;
}

export type ReviewOutcome =
  | {
      status: "accepted";
      entry: BlackboardEntry;
      draft: Draft;
      rejections: number;
      attempts: number;
    }
  | {
      status: "rejected";
      rejections: number;
      attempts: number;
      /** The last rejection's findings, for the replacement's handoff packet (plan.md 2.4). */
      findings: Finding[];
      lastDraft: Draft;
    };

/**
 * Produce, review, and on rejection give the producer the findings for one revision turn, until
 * the critic accepts or the rejection cap is hit. At the cap the outcome is `rejected` and the
 * slot supervisor (A9) replaces the agent; a rejected draft never reaches the blackboard.
 */
export async function produceWithReview(options: ReviewLoopOptions): Promise<ReviewOutcome> {
  const cap = Math.max(1, options.maxRejections ?? DEFAULT_MAX_REJECTIONS);
  let rejections = 0;
  let attempts = 0;
  let revision: Revision | undefined;
  for (;;) {
    attempts += 1;
    const draft = await options.produce(revision);
    const verdict = await options.review(draft, attempts);
    if (verdict.verdict === "accepted") {
      return { status: "accepted", entry: options.commit(draft), draft, rejections, attempts };
    }
    rejections += 1;
    if (rejections >= cap) {
      return {
        status: "rejected",
        rejections,
        attempts,
        findings: verdict.findings,
        lastDraft: draft,
      };
    }
    revision = { findings: verdict.findings, previous: draft };
  }
}
