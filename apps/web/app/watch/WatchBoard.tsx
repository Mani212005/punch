"use client";

import React, { useMemo, useState } from "react";
import Header from "../components/Header";
import Footer from "../components/Footer";
import { createEventSource, useReplayController } from "@/lib/trace";
import type { EventSourceConfig } from "@/lib/trace";
import type { Subtask } from "@punch/shared";

import RunTile from "./components/RunTile";
import BudgetTile from "./components/BudgetTile";
import TakeoverBanner from "./components/TakeoverBanner";
import SlotsTile from "./components/SlotsTile";
import PlanGraphTile from "./components/PlanGraphTile";
import AgentLogsTile from "./components/AgentLogsTile";
import RoutingCardTile from "./components/RoutingCardTile";
import TimelineTile from "./components/TimelineTile";
import SubtaskInspectorModal from "./components/SubtaskInspectorModal";
import ReplayPicker from "./components/ReplayPicker";

interface WatchBoardProps {
  initialTraceId?: string;
}

export default function WatchBoard({ initialTraceId = "takeover" }: WatchBoardProps) {
  const [sourceConfig, setSourceConfig] = useState<EventSourceConfig>({
    kind: "static",
    traceId: initialTraceId,
  });

  const [selectedSubtask, setSelectedSubtask] = useState<Subtask | null>(null);

  const eventSource = useMemo(() => {
    try {
      return createEventSource(sourceConfig);
    } catch {
      return null;
    }
  }, [sourceConfig]);

  const {
    state,
    currentIndex,
    totalEvents,
    isPlaying,
    speed,
    loading,
    error,
    togglePlay,
    stepForward,
    stepBackward,
    scrubTo,
    setSpeed,
  } = useReplayController(eventSource, { autoPlay: false, defaultSpeed: 1 });

  const handleSelectStaticTrace = (traceId: string) => {
    setSourceConfig({ kind: "static", traceId });
  };

  const handleUploadFile = (file: File) => {
    setSourceConfig({ kind: "file", file });
  };

  const handleConnectLive = (engineUrl: string, token: string) => {
    setSourceConfig({
      kind: "sse",
      engineUrl,
      token,
    });
  };

  return (
    <main>
      <div
        className="bz"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          padding: "14px",
          maxWidth: "1280px",
          margin: "0 auto",
        }}
      >
        <Header />

        {/* Replay Picker & Source Navigation */}
        <ReplayPicker
          sourceConfig={sourceConfig}
          onSelectStaticTrace={handleSelectStaticTrace}
          onUploadFile={handleUploadFile}
          onConnectLive={handleConnectLive}
          loading={loading}
          error={error}
        />

        {/* Watch Board Bento Grid */}
        <div className="bz-grid">
          {/* Row 1: Run Tile (8 cols) + Budget Tile (4 cols) */}
          <RunTile
            run={state.run}
            activeTakeover={state.takeover.active}
            onStop={() => {}}
          />
          <BudgetTile budget={state.budget} />

          {/* Row 2: Takeover Banner (12 cols) */}
          {state.takeover.active && (
            <TakeoverBanner
              banner={state.takeover.active}
              subtasks={state.plan.subtasks}
            />
          )}

          {/* Row 3 & 4: Bento layout (3 + 5 + 4 cols = 12 cols) */}
          {/* Slots Tile: 3 cols, 2 rows */}
          <SlotsTile
            run={state.run}
            slots={state.slots}
            planSubtasksCount={state.plan.subtasks.length}
          />

          {/* Plan Graph: 5 cols (Row 3) */}
          <PlanGraphTile
            plan={state.plan}
            activeTakeover={state.takeover.active}
            slots={state.slots}
            onSelectSubtask={(st) => setSelectedSubtask(st)}
            selectedSubtaskId={selectedSubtask?.id}
          />

          {/* Agent Logs: 4 cols, 2 rows */}
          <AgentLogsTile
            entries={state.logs.entries}
            byRole={state.logs.byRole}
          />

          {/* Routing Card: 5 cols (Row 4, directly under Plan Graph) */}
          <RoutingCardTile
            routingMap={state.routing}
            slots={state.slots}
            mode={state.run.mode}
          />

          {/* Row 5: Timeline Gantt with Replay Controls & Scrubber (12 cols) */}
          <TimelineTile
            currentIndex={currentIndex}
            totalEvents={totalEvents}
            isPlaying={isPlaying}
            speed={speed}
            spans={state.timeline.spans}
            markers={state.timeline.markers}
            onTogglePlay={togglePlay}
            onStepForward={stepForward}
            onStepBackward={stepBackward}
            onScrub={scrubTo}
            onSetSpeed={setSpeed}
          />
        </div>

        {/* Subtask Inspector Modal */}
        {selectedSubtask && (
          <SubtaskInspectorModal
            subtask={selectedSubtask}
            blackboard={state.blackboard}
            logs={state.logs.entries}
            onClose={() => setSelectedSubtask(null)}
          />
        )}

        <Footer />
      </div>
    </main>
  );
}
