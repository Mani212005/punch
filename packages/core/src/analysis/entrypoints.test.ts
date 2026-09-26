import { describe, it, expect } from "vitest";
import path from "node:path";
import { findEntrypointsAndRoutes } from "./entrypoints.js";

describe("findEntrypointsAndRoutes", () => {
  const expressFixtureDir = path.resolve(__dirname, "../../../../fixtures/repos/express-app");
  const fastifyFixtureDir = path.resolve(__dirname, "../../../../fixtures/repos/fastify-app");
  const nextjsFixtureDir = path.resolve(__dirname, "../../../../fixtures/repos/nextjs-app");

  it("extracts entrypoints from package.json in express app", async () => {
    const result = await findEntrypointsAndRoutes({
      workdir: expressFixtureDir,
    });

    expect(result.entrypoints.length).toBeGreaterThan(0);

    const mainEntry = result.entrypoints.find((e) => e.type === "main");
    expect(mainEntry).toBeDefined();
    expect(mainEntry?.path).toBe("src/index.ts");

    const binEntry = result.entrypoints.find((e) => e.type === "bin");
    expect(binEntry).toBeDefined();
    expect(binEntry?.path).toBe("src/cli.ts");

    const expEntry = result.entrypoints.find((e) => e.type === "exports");
    expect(expEntry).toBeDefined();
  });

  it("finds Express routes and analyzes reachability of target packages and symbols", async () => {
    const result = await findEntrypointsAndRoutes({
      workdir: expressFixtureDir,
      targetPackage: "qs",
      targetSymbols: ["parse"],
    });

    expect(result.frameworksDetected).toContain("express");
    expect(result.routes.length).toBeGreaterThan(0);

    // Health route
    const healthRoute = result.routes.find((r) => r.path === "/health");
    expect(healthRoute).toBeDefined();
    expect(healthRoute?.method).toBe("GET");

    // Search route (uses qs.parse)
    const searchRoute = result.routes.find((r) => r.path === "/api/search");
    expect(searchRoute).toBeDefined();
    expect(searchRoute?.method).toBe("GET");
    expect(searchRoute?.reachesTargetPackage).toBe(true);
    expect(searchRoute?.reachesTargetSymbols).toContain("parse");

    // Merge route (uses lodash.merge)
    const mergeRoute = result.routes.find((r) => r.path === "/api/merge");
    expect(mergeRoute).toBeDefined();
    expect(mergeRoute?.method).toBe("POST");

    // Users routes
    const usersGet = result.routes.find((r) => r.path === "/users/:id");
    expect(usersGet).toBeDefined();
    expect(usersGet?.method).toBe("GET");
    expect(usersGet?.reachesTargetPackage).toBe(false);

    // Check evidence records
    expect(result.evidence.length).toBeGreaterThan(0);
    const routeEv = result.evidence.find((e) => e.excerpt.includes("/api/search"));
    expect(routeEv).toBeDefined();
  });

  it("discovers routes in Fastify repository", async () => {
    const result = await findEntrypointsAndRoutes({
      workdir: fastifyFixtureDir,
      targetPackage: "axios",
      targetSymbols: ["get", "post"],
    });

    expect(result.frameworksDetected).toContain("fastify");
    expect(result.routes.length).toBeGreaterThanOrEqual(3);

    const getItems = result.routes.find((r) => r.method === "GET" && r.path === "/items");
    expect(getItems).toBeDefined();
    expect(getItems?.reachesTargetPackage).toBe(true);

    const postItems = result.routes.find((r) => r.method === "POST" && r.path === "/items");
    expect(postItems).toBeDefined();
    expect(postItems?.reachesTargetPackage).toBe(true);

    const deleteItems = result.routes.find((r) => r.method === "DELETE" && r.path === "/items/:id");
    expect(deleteItems).toBeDefined();
  });

  it("discovers Next.js App Router and Pages Router endpoints", async () => {
    const result = await findEntrypointsAndRoutes({
      workdir: nextjsFixtureDir,
      targetPackage: "jsonwebtoken",
      targetSymbols: ["verify"],
    });

    expect(result.frameworksDetected).toContain("nextjs_app");
    expect(result.frameworksDetected).toContain("nextjs_pages");

    // App router POST /api/auth
    const postAuth = result.routes.find((r) => r.path === "/api/auth" && r.method === "POST");
    expect(postAuth).toBeDefined();
    expect(postAuth?.framework).toBe("nextjs_app");
    expect(postAuth?.reachesTargetPackage).toBe(true);
    expect(postAuth?.reachesTargetSymbols).toContain("verify");

    // App router GET /api/auth
    const getAuth = result.routes.find((r) => r.path === "/api/auth" && r.method === "GET");
    expect(getAuth).toBeDefined();

    // Pages router ALL /api/status
    const statusApi = result.routes.find((r) => r.path === "/api/status");
    expect(statusApi).toBeDefined();
    expect(statusApi?.framework).toBe("nextjs_pages");
  });
});
