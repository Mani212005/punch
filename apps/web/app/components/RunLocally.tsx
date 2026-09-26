import React from "react";

export default function RunLocally() {
  return (
    <div className="bz-tile ink c6" id="run-locally">
      <div className="bz-label">run it locally</div>
      <div className="bz-log" style={{ padding: 0, background: "none" }}>
        <div>$ npm i -g punch</div>
        <div>$ punch config test</div>
        <div>$ punch serve</div>
        <div className="ok">&gt; paired · token 7f3a-… · open /console</div>
      </div>
    </div>
  );
}
