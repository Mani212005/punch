import test from "node:test";
import assert from "node:assert";
import { hello } from "../index.js";

test("greets by name", () => {
  assert.strictEqual(hello("Ada"), "Hello, Ada");
});

test("greets the world", () => {
  assert.strictEqual(hello(), "Hello, world");
});
