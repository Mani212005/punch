import { InvestigationReport } from "@punch/shared";
import type { BlackboardEntry } from "@punch/shared";

/**
 * Finds the section-8 investigation report (E4) on the blackboard.
 * The executor writes it as a blackboard value; the watch board renders it
 * from there so live and replay stay the same pure function of the trace.
 * Returns null when no entry parses as an InvestigationReport yet.
 */
export function findInvestigationReport(
  blackboard: Record<string, BlackboardEntry>,
): ReturnType<typeof parseReport> {
  for (const entry of Object.values(blackboard)) {
    const parsed = parseReport(entry.value);
    if (parsed) return parsed;
  }
  return null;
}

function parseReport(value: unknown) {
  const direct = InvestigationReport.safeParse(value);
  if (direct.success) return direct.data;
  if (value !== null && typeof value === "object" && "report" in value) {
    const nested = InvestigationReport.safeParse((value as { report: unknown }).report);
    if (nested.success) return nested.data;
  }
  return null;
}
