import React from "react";

export default function RunLocally() {
  return (
    <div className="bz-tile ink c6" id="run-locally">
      <div className="bz-label">run it locally</div>
      <div className="bz-log" style={{ padding: 0, background: "none" }}>
        <div>$ git clone https://github.com/Mani212005/punch</div>
        <div>$ pnpm install &amp;&amp; pnpm build</div>
        <div>$ pnpm punch config test</div>
        <div>$ pnpm punch serve</div>
        <div className="ok">&gt; prints pairing token + viewer token</div>
      </div>
    </div>
  );
}
