
Multi-Agent Systems — Systems That Plan, Delegate and Recover
Background
One model answering one prompt is not a system. A system decomposes a task it was not explicitly programmed for, decides which capability to apply to each part, calls real tools, and keeps going when a step returns something malformed, slow or wrong. Most multi-agent demos fail on that last point: they work beautifully on the happy path and collapse the moment an API returns a 500. The interesting engineering in this track is in the recovery, the stopping conditions and the audit trail — not in the number of agents
Challenge
Build a multi-agent system that decomposes a non-trivial task, delegates across specialised agents, uses real tools, and recovers when a step fails — producing a trace a human can audit afterwards.
Core requirements
- Solve a task that genuinely needs more than one agent, and be ready to justify every agent you added.
- Demonstrate real planning and delegation, not a hardcoded chain wearing an agent costume.
- Call at least one real external tool or API and handle its actual response shapes.
- Survive a failed, slow or malformed step without the whole run collapsing — retry, fall back or degrade gracefully.
- Produce a readable trace: which agent did what, with which inputs, and why it chose that.
- Enforce a stopping condition — a step limit, a token or cost budget, or a -timeout.
- Require human approval for any irreversible or sensitive action.
Advanced directions
- Planner, executor and critic architectures, with the critic actually able to reject work.
- Shared memory or blackboard coordination between agents.
- Tool selection under uncertainty, including choosing not to call anything.
- Retry, fallback and compensation strategies for partially completed work.
- Cost and latency measured per run, not estimated.
- Task completion rate measured across repeated runs of the same input.
