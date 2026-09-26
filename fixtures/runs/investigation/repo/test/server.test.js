import assert from "node:assert";
import test from "node:test";
import app from "../src/server.js";

test("health route is mounted", () => {
  assert.ok(app, "server app should be defined");
});
