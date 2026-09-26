import React from "react";

export default function WhereThingsRun() {
  return (
    <div className="bz-tile c6">
      <div className="bz-label">where things run</div>
      <div style={{ fontSize: "12px", lineHeight: 1.5 }}>
        Engine, agents, keys, and tool calls run on your machine. This site holds no secrets; it
        renders the event stream from your engine, live, or replays a recorded one.
      </div>
      <div className="bz-mono bz-muted">
        localhost:4141 · pairing token · read-only viewer token
      </div>
    </div>
  );
}
