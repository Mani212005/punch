import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import LandingPage from "../page";
import HowItWorks from "../components/HowItWorks";
import Hero from "../components/Hero";
import FeatureTiles from "../components/FeatureTiles";

describe("Landing Page", () => {
  it("renders header, hero, and main brand elements", () => {
    render(<LandingPage />);
    expect(screen.getByText("Punch")).toBeInTheDocument();
    expect(
      screen.getByText("Agents that plan, delegate, and take over for each other."),
    ).toBeInTheDocument();
    expect(screen.getByText("github.com/Mani212005/punch")).toBeInTheDocument();
  });

  it("renders all 3 geometric how-it-works tiles", () => {
    render(<HowItWorks />);
    expect(screen.getByText("01 · plan")).toBeInTheDocument();
    expect(screen.getByText("The planner writes a subtask graph")).toBeInTheDocument();
    expect(screen.getByText("02 · delegate")).toBeInTheDocument();
    expect(screen.getByText("Jev assigns your agents to roles")).toBeInTheDocument();
    expect(screen.getByText("03 · recover")).toBeInTheDocument();
    expect(screen.getByText("A failed agent is replaced mid-task")).toBeInTheDocument();
  });

  it("uses blue for active step highlight, never red border", () => {
    render(<HowItWorks />);
    const planTile = screen.getByRole("button", { name: "Step 1: Plan" });
    expect(planTile).toHaveStyle({
      borderColor: "var(--bz-blue)",
      boxShadow: "inset 0 0 0 2px var(--bz-blue)",
    });

    const delegateBtn = screen.getByRole("button", { name: /02 · Delegate/i });
    fireEvent.click(delegateBtn);

    const delegateTile = screen.getByRole("button", { name: "Step 2: Delegate" });
    expect(delegateTile).toHaveStyle({
      borderColor: "var(--bz-blue)",
      boxShadow: "inset 0 0 0 2px var(--bz-blue)",
    });

    const recoverBtn = screen.getByRole("button", { name: /03 · Recover/i });
    fireEvent.click(recoverBtn);

    const recoverTile = screen.getByRole("button", { name: "Step 3: Recover" });
    expect(recoverTile).toHaveStyle({
      borderColor: "var(--bz-blue)",
      boxShadow: "inset 0 0 0 2px var(--bz-blue)",
    });
  });

  it("renders model APIs and local CLIs with full plan.md §3 details", () => {
    render(<HowItWorks />);
    expect(screen.getByText("MODEL APIS (Remote)")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getAllByText("Gemini").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("OpenAI-c")).toBeInTheDocument();

    expect(screen.getByText("LOCAL CLIS (Isolated Workdirs)")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("OpenCode")).toBeInTheDocument();
    expect(screen.getByText("Antigravity")).toBeInTheDocument();
  });

  it("allows switching between 3 steps in HowItWorks", () => {
    render(<HowItWorks />);
    const delegateBtn = screen.getByRole("button", { name: /02 · Delegate/i });
    fireEvent.click(delegateBtn);
    expect(screen.getByText(/Jev Router evaluates agent strengths/i)).toBeInTheDocument();

    const recoverBtn = screen.getByRole("button", { name: /03 · Recover/i });
    fireEvent.click(recoverBtn);
    expect(screen.getByText(/Slot supervisor detects slot failure/i)).toBeInTheDocument();
  });

  it("renders 6 feature tiles with links to trace moments", () => {
    render(<FeatureTiles />);
    expect(screen.getByText("planning and delegation")).toBeInTheDocument();
    expect(screen.getByText("real tools, real failures")).toBeInTheDocument();
    expect(screen.getByText("agent takeover")).toBeInTheDocument();
    expect(screen.getByText("audit trail")).toBeInTheDocument();
    expect(screen.getByText("budgets and stopping")).toBeInTheDocument();
    expect(screen.getByText("human approval")).toBeInTheDocument();

    expect(screen.getByText("see 00:04 · clean run")).toHaveAttribute(
      "href",
      "/watch/clean-run#00:04",
    );
    expect(screen.getByText("see 00:41 · chaos run")).toHaveAttribute(
      "href",
      "/watch/chaos-run#00:41",
    );
    expect(screen.getByText("see 01:12 · takeover run")).toHaveAttribute(
      "href",
      "/watch/takeover#01:12",
    );
  });

  it("renders the watch button pointing to /watch/takeover", () => {
    render(<Hero />);
    const watchBtn = screen.getByRole("link", { name: /Watch the takeover run/i });
    expect(watchBtn).toHaveAttribute("href", "/watch/takeover");
  });
});
