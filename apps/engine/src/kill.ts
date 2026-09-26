import { requestKill } from "@punch/core";
import { SlotRole } from "@punch/shared";

export interface KillCommandOptions {
  runsDir?: string;
  message?: string;
}

/**
 * `punch kill <runId> <slot>`: the operator lever from plan.md 2.6. Hands the request to the
 * running engine through the run's control directory; the supervisor fails the slot with reason
 * `operator_kill` and a replacement takes over.
 */
export function killCommand(
  runId: string,
  slot: string,
  options: KillCommandOptions = {},
): string {
  const role = SlotRole.safeParse(slot);
  if (!role.success) {
    throw new Error(`unknown slot "${slot}"; expected one of ${SlotRole.options.join(", ")}`);
  }
  requestKill(options.runsDir ?? "runs", runId, role.data, options.message);
  return `kill requested for the ${role.data} slot of run ${runId}`;
}
