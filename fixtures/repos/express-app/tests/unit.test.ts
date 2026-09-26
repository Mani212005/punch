import { describe, it, expect } from "vitest";
import { formatUrl } from "../src/utils/reexport.js";
import { processData } from "../src/services/data.js";

describe("Unit Helpers Test", () => {
  it("formats URL properly", () => {
    const res = formatUrl("https://example.com", { a: "1" });
    expect(res).toContain("formatted=true");
  });

  it("processes data with re-exported parser", () => {
    const res = processData("key=hello");
    expect(res.val).toBe("hello");
  });
});
