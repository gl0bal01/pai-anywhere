import { describe, expect, test } from "bun:test";
import { cmdExists } from "../src/lib/sys";

describe("cmdExists allowlist (L4)", () => {
  test("accepts literal binary names", () => {
    // `true` always exists in the probe shell; exercises the happy path.
    expect(cmdExists("sh")).toBe(true);
  });

  test("throws on shell metacharacters instead of executing them", () => {
    expect(() => cmdExists("foo; rm -rf /")).toThrow();
    expect(() => cmdExists("$(id)")).toThrow();
    expect(() => cmdExists("a'b'c")).toThrow();
    expect(() => cmdExists("x/y")).toThrow();
    expect(() => cmdExists("")).toThrow();
  });
});
