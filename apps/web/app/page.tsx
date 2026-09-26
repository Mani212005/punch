import React from "react";
import Header from "./components/Header";
import Hero from "./components/Hero";
import HowItWorks from "./components/HowItWorks";
import FeatureTiles from "./components/FeatureTiles";
import RunLocally from "./components/RunLocally";
import WhereThingsRun from "./components/WhereThingsRun";
import Footer from "./components/Footer";

export default function LandingPage() {
  return (
    <main>
      <div className="bz" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <Header />
        <div className="bz-grid">
          <Hero />
          <HowItWorks />
          <FeatureTiles />
          <RunLocally />
          <WhereThingsRun />
        </div>
        <Footer />
      </div>
    </main>
  );
}
