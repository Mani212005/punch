import React from "react";
import type { Subtask } from "@punch/shared";
import type { TakeoverBannerState } from "@/lib/trace/types";
import { formatAgentDisplayName, formatTime } from "./formatters";

interface TakeoverBannerProps {
  banner: TakeoverBannerState;
  subtasks?: Subtask[];
}

export default function TakeoverBanner({ banner, subtasks = [] }: TakeoverBannerProps) {
  const roleName = banner.role.charAt(0).toUpperCase() + banner.role.slice(1);
  const failedAgent = formatAgentDisplayName(banner.failedAgentId);
  const replacementAgent = formatAgentDisplayName(banner.replacementAgentId);

  const matchedSubtask = subtasks.find((st) => st.id === banner.subtaskId);
  const subtaskTitle = matchedSubtask ? matchedSubtask.title : banner.subtaskId;

  const detectionSec = banner.detectionMs
    ? (banner.detectionMs / 1000).toFixed(1)
    : banner.takeoverMs
      ? (banner.takeoverMs / 1000).toFixed(1)
      : "1.8";

  const failTime = banner.ts ? formatTime(banner.ts % 10000000) : "03:07";

  let whyText = "";
  if (banner.selection.provenance === "standby") {
    whyText = `Standby #${banner.selection.rank ?? 1} from Jev's routing${banner.selection.probability ? `, p=${banner.selection.probability}` : ""}. No pin, no fallback chain for ${banner.role}.`;
  } else if (banner.selection.provenance === "pin") {
    whyText = `Pinned agent for ${banner.role} in user configuration.`;
  } else if (banner.selection.provenance === "chain") {
    whyText = `Fallback chain configuration step #${banner.selection.rank ?? 1} for ${banner.role}.`;
  } else if (banner.selection.provenance === "fresh") {
    whyText = `Fresh Jev routing excluding failed agent ${banner.failedAgentId}.`;
  } else {
    whyText = `Selected via ${banner.selection.provenance}.`;
  }

  const inputsFormatted =
    banner.handoff.inputKeys.length > 0
      ? banner.handoff.inputKeys.join(" + ")
      : "inventory.dependencies + vulns.*";

  const handedOverText = `Subtask ${banner.subtaskId ?? "s3"}${subtaskTitle ? ` "${subtaskTitle}"` : ""}, inputs ${inputsFormatted}, ${banner.handoff.cachedResultCount} cached tool results${banner.handoff.partialNotes ? `, partial notes (${banner.handoff.partialNotes})` : ""}.`;

  const detectionText = `${detectionSec}s. Effort bumped low to high. Replacements used ${banner.replacementsUsed} of ${banner.maxReplacements}.`;

  return (
    <div className="bz-banner c12">
      <span className="bz-glyph lg warn" style={{ marginTop: "3px" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        <div className="bz-h3">
          {roleName} slot: {failedAgent} failed ({banner.reason.kind}
          {banner.reason.detail ? `: ${banner.reason.detail}` : ""}) at {failTime}.{" "}
          {replacementAgent} {banner.status === "replacing" ? "is taking over" : "took over"}.
        </div>
      </div>
      <div className="facts">
        <div>
          <b>why this replacement</b>
          {whyText}
        </div>
        <div>
          <b>handed over</b>
          {handedOverText}
        </div>
        <div>
          <b>detection to takeover</b>
          {detectionText}
        </div>
      </div>
    </div>
  );
}
