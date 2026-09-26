import { describe, it, expect } from "vitest";
import { apiRouter } from "../src/routes/api.js";
import qs from "qs";

describe("API Routes Test", () => {
  it("parses query strings correctly with qs", () => {
    const raw = "foo=bar&baz=qux";
    // Call site within test
    const parsed = qs.parse(raw);
    expect(parsed).toEqual({ foo: "bar", baz: "qux" });
  });

  it("router is defined", () => {
    expect(apiRouter).toBeDefined();
  });
});
