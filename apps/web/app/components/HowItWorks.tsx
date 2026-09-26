"use client";

import React, { useState, useEffect } from "react";

type Step = "plan" | "delegate" | "recover";

export default function HowItWorks() {
  const [activeStep, setActiveStep] = useState<Step>("plan");
  const [isAutoPlaying, setIsAutoPlaying] = useState<boolean>(true);

  useEffect(() => {
    if (!isAutoPlaying) return;
    const steps: Step[] = ["plan", "delegate", "recover"];
    const interval = setInterval(() => {
      setActiveStep((current) => {
        const nextIndex = (steps.indexOf(current) + 1) % steps.length;
        return steps[nextIndex];
      });
    }, 4500);
    return () => clearInterval(interval);
  }, [isAutoPlaying]);

  const selectStep = (step: Step) => {
    setIsAutoPlaying(false);
    setActiveStep(step);
  };

  return (
    <>
      {/* Three geometric how-it-works tiles matching DESIGN.md §5 & mockups.html */}
      <div
        className={`bz-tile c4 ${activeStep === "plan" ? "alt" : ""}`}
        onClick={() => selectStep("plan")}
        style={{
          cursor: "pointer",
          borderColor: activeStep === "plan" ? "var(--bz-blue)" : "var(--bz-ink)",
          boxShadow: activeStep === "plan" ? "inset 0 0 0 2px var(--bz-blue)" : "none",
          transition:
            "border-color var(--bz-dur) var(--bz-ease), box-shadow var(--bz-dur) var(--bz-ease)",
        }}
        role="button"
        tabIndex={0}
        aria-label="Step 1: Plan"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") selectStep("plan");
        }}
      >
        <div className="bz-label">01 · plan</div>
        <div
          style={{
            width: "40px",
            height: "40px",
            borderRadius: "50%",
            background: "var(--bz-red)",
          }}
        />
        <div className="bz-h3">The planner writes a subtask graph</div>
        <div className="bz-muted" style={{ fontSize: "12px" }}>
          Dependencies, role hints, and what counts as done for each subtask.
        </div>
      </div>

      <div
        className={`bz-tile c4 ${activeStep === "delegate" ? "alt" : ""}`}
        onClick={() => selectStep("delegate")}
        style={{
          cursor: "pointer",
          borderColor: activeStep === "delegate" ? "var(--bz-blue)" : "var(--bz-ink)",
          boxShadow: activeStep === "delegate" ? "inset 0 0 0 2px var(--bz-blue)" : "none",
          transition:
            "border-color var(--bz-dur) var(--bz-ease), box-shadow var(--bz-dur) var(--bz-ease)",
        }}
        role="button"
        tabIndex={0}
        aria-label="Step 2: Delegate"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") selectStep("delegate");
        }}
      >
        <div className="bz-label">02 · delegate</div>
        <div style={{ width: "40px", height: "40px", background: "var(--bz-blue)" }} />
        <div className="bz-h3">Jev assigns your agents to roles</div>
        <div className="bz-muted" style={{ fontSize: "12px" }}>
          Probabilities you can see. Pins and rules you write outrank it.
        </div>
      </div>

      <div
        className={`bz-tile c4 ${activeStep === "recover" ? "alt" : ""}`}
        onClick={() => selectStep("recover")}
        style={{
          cursor: "pointer",
          borderColor: activeStep === "recover" ? "var(--bz-blue)" : "var(--bz-ink)",
          boxShadow: activeStep === "recover" ? "inset 0 0 0 2px var(--bz-blue)" : "none",
          transition:
            "border-color var(--bz-dur) var(--bz-ease), box-shadow var(--bz-dur) var(--bz-ease)",
        }}
        role="button"
        tabIndex={0}
        aria-label="Step 3: Recover"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") selectStep("recover");
        }}
      >
        <div className="bz-label">03 · recover</div>
        <div
          style={{
            width: 0,
            height: 0,
            borderLeft: "22px solid transparent",
            borderRight: "22px solid transparent",
            borderBottom: "40px solid var(--bz-yellow)",
          }}
        />
        <div className="bz-h3">A failed agent is replaced mid-task</div>
        <div className="bz-muted" style={{ fontSize: "12px" }}>
          The standby resumes with the cached tool results. You watch it happen.
        </div>
      </div>

      {/* Architecture diagram from plan.md section 3 */}
      <div className="bz-tile c12" style={{ gap: "12px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <div className="bz-label">
            <span className="bz-glyph lg run" />
            architecture &amp; execution flow · plan.md §3
          </div>
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <span className="bz-mono bz-muted" style={{ fontSize: "11px", marginRight: "4px" }}>
              Step:
            </span>
            <div className="bz-seg">
              <button
                type="button"
                className={`bz-btn sm ${activeStep === "plan" ? "primary" : ""}`}
                onClick={() => selectStep("plan")}
              >
                01 · Plan
              </button>
              <button
                type="button"
                className={`bz-btn sm ${activeStep === "delegate" ? "primary" : ""}`}
                onClick={() => selectStep("delegate")}
              >
                02 · Delegate
              </button>
              <button
                type="button"
                className={`bz-btn sm ${activeStep === "recover" ? "primary" : ""}`}
                onClick={() => selectStep("recover")}
              >
                03 · Recover
              </button>
            </div>
            {isAutoPlaying && (
              <span className="bz-chip ghost" style={{ fontSize: "9px" }}>
                auto-stepping
              </span>
            )}
          </div>
        </div>

        {/* Step narrative description */}
        <div
          style={{
            padding: "8px 12px",
            border: "var(--bz-line) solid var(--bz-ink)",
            background:
              activeStep === "recover"
                ? "var(--bz-yellow)"
                : "color-mix(in srgb, var(--bz-blue) 12%, var(--bz-paper))",
            fontSize: "12px",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            transition: "background var(--bz-dur) var(--bz-ease)",
          }}
        >
          <span className={`bz-glyph lg ${activeStep === "recover" ? "warn" : "run"}`} />
          <div style={{ flex: 1 }}>
            {activeStep === "plan" && (
              <span>
                <strong>01 · Plan:</strong> The Orchestrator accepts the user brief and invokes the
                Planner to construct a dependency DAG of subtasks (s1..s7) with role hints and
                acceptance contracts.
              </span>
            )}
            {activeStep === "delegate" && (
              <span>
                <strong>02 · Delegate:</strong> Jev Router evaluates agent strengths, cost tiers,
                and policy to produce role assignments and standby probability vectors.
              </span>
            )}
            {activeStep === "recover" && (
              <span>
                <strong>03 · Recover:</strong> Slot supervisor detects slot failure (operator kill,
                stall, or 5xx). In 1.8s, the #1 standby takes over with 5 cached tool results.
              </span>
            )}
          </div>
        </div>

        {/* Responsive Architecture Diagram Container: below 900px allows horizontal scroll so text stays crisp & legible */}
        <div
          style={{
            width: "100%",
            overflowX: "auto",
            WebkitOverflowScrolling: "touch",
            paddingBottom: "4px",
          }}
        >
          <div style={{ minWidth: "820px" }}>
            <svg
              className="fig"
              viewBox="0 0 940 392"
              role="img"
              aria-label="Architecture diagram showing Website, Node Engine, Jev Router, Slots, and Model Adapters with 3-step execution"
              style={{ width: "100%", height: "auto", display: "block" }}
            >
              <defs>
                <marker
                  id="bzarr-arch"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill="#121212" />
                </marker>
                <marker
                  id="bzarr-blue"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill="#1F48C5" />
                </marker>
              </defs>

              {/* Left container: Website */}
              <rect
                x="10"
                y="10"
                width="240"
                height="260"
                fill="var(--bz-paper-2)"
                stroke="var(--bz-ink)"
                strokeWidth="2"
                rx="6"
              />
              <text x="22" y="32" fontSize="11" fontWeight="700" letterSpacing="0.06em">
                WEBSITE (Next.js on Vercel)
              </text>
              <text x="22" y="47" fontSize="9" className="t-muted">
                public · zero secrets · event window
              </text>

              <rect
                x="22"
                y="60"
                width="216"
                height="34"
                fill="var(--bz-paper)"
                stroke="var(--bz-ink)"
                strokeWidth="2"
              />
              <text x="32" y="81" fontSize="10" fontWeight="600">
                / landing + features
              </text>

              <rect
                x="22"
                y="102"
                width="216"
                height="42"
                fill="var(--bz-paper)"
                stroke="var(--bz-ink)"
                strokeWidth="2"
              />
              <text x="32" y="120" fontSize="10" fontWeight="600">
                /watch live &amp; /watch/:id
              </text>
              <text x="32" y="134" fontSize="8" className="t-muted">
                SSE event stream or trace JSONL
              </text>

              <rect
                x="22"
                y="152"
                width="216"
                height="34"
                fill="var(--bz-paper)"
                stroke="var(--bz-ink)"
                strokeWidth="2"
              />
              <text x="32" y="173" fontSize="10" fontWeight="600">
                /console controls (paired)
              </text>

              <rect
                x="22"
                y="194"
                width="216"
                height="64"
                fill="var(--bz-paper)"
                stroke="var(--bz-ink)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <text x="32" y="212" fontSize="9" fontWeight="600" className="t-muted">
                PURE TRACE REDUCER
              </text>
              <text x="32" y="228" fontSize="8" className="t-muted">
                UI state = fn(trace events)
              </text>
              <text x="32" y="242" fontSize="8" className="t-muted">
                live &amp; replay share components
              </text>

              {/* Connection: Website <-> Engine */}
              <path
                d="M250 120 L310 120"
                stroke="var(--bz-ink)"
                strokeWidth="2"
                markerEnd="url(#bzarr-arch)"
              />
              <path
                d="M310 134 L250 134"
                stroke="var(--bz-ink)"
                strokeWidth="2"
                markerEnd="url(#bzarr-arch)"
              />
              <text x="280" y="112" fontSize="8" textAnchor="middle" fontWeight="700">
                REST
              </text>
              <text x="280" y="148" fontSize="8" textAnchor="middle" fontWeight="700">
                SSE
              </text>

              {/* Right container: Engine */}
              <rect
                x="310"
                y="10"
                width="620"
                height="260"
                fill="var(--bz-paper)"
                stroke="var(--bz-ink)"
                strokeWidth="2"
                rx="6"
              />
              <text x="322" y="32" fontSize="11" fontWeight="700" letterSpacing="0.06em">
                ENGINE (Node 20+ on user machine)
              </text>
              <text x="730" y="32" fontSize="9" className="t-muted" textAnchor="start">
                localhost:4141 · pairing token
              </text>

              {/* HTTP API Bar */}
              <rect
                x="322"
                y="44"
                width="596"
                height="28"
                fill="var(--bz-paper-2)"
                stroke="var(--bz-ink)"
                strokeWidth="2"
              />
              <text x="334" y="62" fontSize="10" fontWeight="700">
                HTTP API (node:http) + SSE
              </text>
              <text x="610" y="62" fontSize="9" className="t-muted">
                CORS · tokens · session persistence
              </text>

              {/* Box 1: Orchestrator + Planner (Step 1 highlight: Blue for active) */}
              <rect
                x="322"
                y="80"
                width="186"
                height="116"
                fill={
                  activeStep === "plan"
                    ? "color-mix(in srgb, var(--bz-blue) 12%, var(--bz-paper))"
                    : "var(--bz-paper)"
                }
                stroke={activeStep === "plan" ? "var(--bz-blue)" : "var(--bz-ink)"}
                strokeWidth={activeStep === "plan" ? 3 : 2}
                style={{ transition: "all var(--bz-dur) var(--bz-ease)" }}
              />
              <text
                x="332"
                y="98"
                fontSize="10"
                fontWeight="700"
                fill={activeStep === "plan" ? "var(--bz-blue)" : "var(--bz-ink)"}
              >
                01 · Planner &amp; DAG
              </text>
              <text x="332" y="113" fontSize="8" className="t-muted">
                Orchestrator brief intake
              </text>
              {/* Subtask DAG Mini */}
              <rect x="332" y="122" width="40" height="18" fill="var(--bz-ink)" />
              <text x="352" y="134" fontSize="7" textAnchor="middle" className="inv">
                s1 inv
              </text>
              <path
                d="M372 131 L384 131"
                stroke="var(--bz-ink)"
                strokeWidth="1"
                markerEnd="url(#bzarr-arch)"
              />
              <rect x="384" y="122" width="46" height="18" fill="var(--bz-blue)" />
              <text x="407" y="134" fontSize="7" textAnchor="middle" className="inv">
                s2 vulns
              </text>
              <path
                d="M430 131 L442 131"
                stroke="var(--bz-ink)"
                strokeWidth="1"
                markerEnd="url(#bzarr-arch)"
              />
              <rect
                x="442"
                y="122"
                width="56"
                height="18"
                fill="var(--bz-paper)"
                stroke="var(--bz-ink)"
                strokeWidth="1"
                strokeDasharray="2 2"
              />
              <text x="470" y="134" fontSize="7" textAnchor="middle">
                s3..s7
              </text>
              <text x="332" y="158" fontSize="8" className="t-muted">
                Acceptance schemas
              </text>
              <text x="332" y="172" fontSize="8" className="t-muted">
                Role requirements
              </text>

              {/* Box 2: Jev Router & Policy (Step 2 highlight: Blue for active) */}
              <rect
                x="518"
                y="80"
                width="186"
                height="116"
                fill={
                  activeStep === "delegate"
                    ? "color-mix(in srgb, var(--bz-blue) 12%, var(--bz-paper))"
                    : "var(--bz-paper)"
                }
                stroke={activeStep === "delegate" ? "var(--bz-blue)" : "var(--bz-ink)"}
                strokeWidth={activeStep === "delegate" ? 3 : 2}
                style={{ transition: "all var(--bz-dur) var(--bz-ease)" }}
              />
              <text
                x="528"
                y="98"
                fontSize="10"
                fontWeight="700"
                fill={activeStep === "delegate" ? "var(--bz-blue)" : "var(--bz-ink)"}
              >
                02 · Jev Router &amp; Policy
              </text>
              <text x="528" y="113" fontSize="8" className="t-muted">
                Scores &amp; Choices on task
              </text>
              {/* Probabilities Mini */}
              <text x="528" y="132" fontSize="8" fontWeight="600">
                Opus 5
              </text>
              <rect
                x="580"
                y="124"
                width="70"
                height="8"
                fill="var(--bz-paper)"
                stroke="var(--bz-ink)"
                strokeWidth="1"
              />
              <rect x="580" y="124" width="36" height="8" fill="var(--bz-blue)" />
              <text x="658" y="131" fontSize="8" className="bz-num">
                0.52
              </text>

              <text x="528" y="148" fontSize="8" fontWeight="600">
                Gemini
              </text>
              <rect
                x="580"
                y="140"
                width="70"
                height="8"
                fill="var(--bz-paper)"
                stroke="var(--bz-ink)"
                strokeWidth="1"
              />
              <rect x="580" y="140" width="17" height="8" fill="var(--bz-ink-3)" />
              <text x="658" y="147" fontSize="8" className="bz-num">
                0.24
              </text>
              <text x="528" y="172" fontSize="8" className="t-muted">
                Standby lists ranked
              </text>

              {/* Box 3: Slots & Supervisor (Step 3 highlight: Attention/Yellow container, Red for killed, Blue for replacement) */}
              <rect
                x="714"
                y="80"
                width="204"
                height="116"
                fill={
                  activeStep === "recover"
                    ? "color-mix(in srgb, var(--bz-yellow) 40%, var(--bz-paper))"
                    : "var(--bz-paper)"
                }
                stroke="var(--bz-ink)"
                strokeWidth={activeStep === "recover" ? 3 : 2}
                style={{ transition: "all var(--bz-dur) var(--bz-ease)" }}
              />
              <text x="724" y="98" fontSize="10" fontWeight="700">
                03 · Slot Supervisor &amp; Handoff
              </text>
              <text x="724" y="113" fontSize="8" className="t-muted">
                Heartbeat silence / 5xx / kill
              </text>
              {/* Takeover visual */}
              <rect
                x="724"
                y="122"
                width="80"
                height="20"
                fill={activeStep === "recover" ? "var(--bz-red)" : "var(--bz-paper)"}
                stroke="var(--bz-ink)"
                strokeWidth="1"
              />
              <text
                x="764"
                y="135"
                fontSize="8"
                textAnchor="middle"
                fill={activeStep === "recover" ? "var(--bz-paper)" : "var(--bz-ink)"}
              >
                {activeStep === "recover" ? "x Opus 5 (killed)" : "Researcher slot"}
              </text>
              <path
                d="M804 132 L822 132"
                stroke="var(--bz-ink)"
                strokeWidth="2"
                markerEnd="url(#bzarr-arch)"
              />
              <rect
                x="822"
                y="122"
                width="86"
                height="20"
                fill={activeStep === "recover" ? "var(--bz-blue)" : "var(--bz-paper-2)"}
                stroke="var(--bz-ink)"
                strokeWidth="1"
              />
              <text
                x="865"
                y="135"
                fontSize="8"
                textAnchor="middle"
                fill={activeStep === "recover" ? "var(--bz-paper)" : "var(--bz-ink)"}
              >
                {activeStep === "recover" ? "Gemini (resumed)" : "Standby #1"}
              </text>
              <text x="724" y="160" fontSize="8" fontWeight="700">
                1.8s takeover · 5 cached results
              </text>
              <text x="724" y="174" fontSize="8" className="t-muted">
                Inputs + notes transferred
              </text>

              {/* Tools & Blackboard Bar */}
              <rect
                x="322"
                y="206"
                width="596"
                height="54"
                fill="var(--bz-paper-2)"
                stroke="var(--bz-ink)"
                strokeWidth="2"
              />
              <text x="334" y="224" fontSize="9" fontWeight="700">
                TOOL LAYER &amp; AUDIT TRAIL
              </text>
              <text x="334" y="240" fontSize="8">
                OSV · npm · GitHub · Cache · Retry/Backoff · Fallback · Approval Gate · Blackboard ·
                Budget
              </text>
              <text x="334" y="252" fontSize="8" className="t-muted">
                Append-only runs/&lt;id&gt;/trace.jsonl audit trail
              </text>

              {/* Connectors from Engine to APIs/CLIs */}
              <path
                d="M460 260 L460 286"
                stroke="var(--bz-ink)"
                strokeWidth="2"
                markerEnd="url(#bzarr-arch)"
              />
              <path
                d="M780 260 L780 286"
                stroke="var(--bz-ink)"
                strokeWidth="2"
                markerEnd="url(#bzarr-arch)"
              />

              {/* Bottom section: Model APIs (Remote) */}
              <rect
                x="310"
                y="286"
                width="300"
                height="96"
                fill="var(--bz-paper)"
                stroke="var(--bz-ink)"
                strokeWidth="2"
                rx="4"
              />
              <text x="322" y="303" fontSize="10" fontWeight="700">
                MODEL APIS (Remote)
              </text>
              <text x="598" y="303" fontSize="8" textAnchor="end" className="t-muted">
                toolCalling: true
              </text>
              <line x1="322" y1="310" x2="598" y2="310" stroke="var(--bz-ink-3)" strokeWidth="1" />

              {/* Anthropic */}
              <rect
                x="322"
                y="316"
                width="84"
                height="15"
                fill="var(--bz-paper-2)"
                stroke="var(--bz-ink)"
                strokeWidth="1"
              />
              <text x="364" y="327" fontSize="8" fontWeight="700" textAnchor="middle">
                Anthropic
              </text>
              <text x="412" y="327" fontSize="8" className="t-muted">
                @anthropic-ai/sdk · betaZodTool · effort
              </text>

              {/* Gemini */}
              <rect
                x="322"
                y="336"
                width="84"
                height="15"
                fill="var(--bz-paper-2)"
                stroke="var(--bz-ink)"
                strokeWidth="1"
              />
              <text x="364" y="347" fontSize="8" fontWeight="700" textAnchor="middle">
                Gemini
              </text>
              <text x="412" y="347" fontSize="8" className="t-muted">
                @google/genai · function declarations
              </text>

              {/* OpenAI-compat */}
              <rect
                x="322"
                y="356"
                width="84"
                height="15"
                fill="var(--bz-paper-2)"
                stroke="var(--bz-ink)"
                strokeWidth="1"
              />
              <text x="364" y="367" fontSize="8" fontWeight="700" textAnchor="middle">
                OpenAI-compat
              </text>
              <text x="412" y="367" fontSize="8" className="t-muted">
                openai SDK · baseUrl · custom models
              </text>

              {/* Bottom section: Local CLIs (Isolated Workdirs) */}
              <rect
                x="630"
                y="286"
                width="300"
                height="96"
                fill="var(--bz-paper)"
                stroke="var(--bz-ink)"
                strokeWidth="2"
                rx="4"
              />
              <text x="642" y="303" fontSize="10" fontWeight="700">
                LOCAL CLIS (Isolated Workdirs)
              </text>
              <text x="918" y="303" fontSize="8" textAnchor="end" className="t-muted">
                toolCalling: false
              </text>
              <line x1="642" y1="310" x2="918" y2="310" stroke="var(--bz-ink-3)" strokeWidth="1" />

              {/* Claude Code */}
              <rect
                x="642"
                y="316"
                width="68"
                height="15"
                fill="var(--bz-paper-2)"
                stroke="var(--bz-ink)"
                strokeWidth="1"
              />
              <text x="676" y="327" fontSize="7.5" fontWeight="700" textAnchor="middle">
                Claude Code
              </text>
              <text x="716" y="327" fontSize="8" className="t-muted">
                spawn isolated dir · streamed JSON
              </text>

              {/* OpenCode */}
              <rect
                x="642"
                y="336"
                width="68"
                height="15"
                fill="var(--bz-paper-2)"
                stroke="var(--bz-ink)"
                strokeWidth="1"
              />
              <text x="676" y="347" fontSize="7.5" fontWeight="700" textAnchor="middle">
                OpenCode
              </text>
              <text x="716" y="347" fontSize="8" className="t-muted">
                free · prompt file · schema validation
              </text>

              {/* Antigravity */}
              <rect
                x="642"
                y="356"
                width="68"
                height="15"
                fill="var(--bz-paper-2)"
                stroke="var(--bz-ink)"
                strokeWidth="1"
              />
              <text x="676" y="367" fontSize="7.5" fontWeight="700" textAnchor="middle">
                Antigravity
              </text>
              <text x="716" y="367" fontSize="8" className="t-muted">
                AGY CLI · streamed JSON · correction
              </text>
            </svg>
          </div>
        </div>
      </div>
    </>
  );
}
