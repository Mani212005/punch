import { describe, it, expect } from "vitest";
import { verifyToken, decodeToken } from "../lib/auth.js";
import jwt from "jsonwebtoken";

describe("Next.js Auth Module Tests", () => {
  it("verifies and decodes token correctly", () => {
    const secret = "secret123";
    // Call site in test
    const token = jwt.sign({ user: "alice" }, secret);
    const directVerified = jwt.verify(token, secret);
    expect(directVerified).toBeDefined();

    const decoded = verifyToken(token, secret);
    expect(decoded).toHaveProperty("user", "alice");
  });

  it("decodes unverified token", () => {
    const rawToken = jwt.sign({ data: 123 }, "secret");
    const res = decodeToken(rawToken);
    expect(res).toBeDefined();
  });
});
