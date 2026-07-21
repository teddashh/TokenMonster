import { describe, expect, it } from "vitest";

import {
  originNavigationGuard,
  petViewUrl
} from "../src/main/pet/navigation.js";

function prevented(origin: string, targetUrl: string): boolean {
  let wasPrevented = false;
  originNavigationGuard(origin)(
    {
      preventDefault: () => {
        wasPrevented = true;
      }
    },
    targetUrl
  );
  return wasPrevented;
}

const ORIGIN = "http://127.0.0.1:7777";

describe("petViewUrl", () => {
  it("adds the pet view without losing gateway URL components", () => {
    expect(
      petViewUrl(
        `${ORIGIN}/__tokenmonster/bootstrap/secret?mode=compact#character`
      )
    ).toBe(
      `${ORIGIN}/__tokenmonster/bootstrap/secret?mode=compact&view=pet#character`
    );
  });

  it("replaces an existing view parameter", () => {
    expect(petViewUrl(`${ORIGIN}/?view=dashboard`)).toBe(`${ORIGIN}/?view=pet`);
  });
});

describe("originNavigationGuard", () => {
  it("allows same-origin navigation", () => {
    expect(prevented(ORIGIN, "http://127.0.0.1:7777/")).toBe(false);
    expect(prevented(ORIGIN, "http://127.0.0.1:7777/api/companion")).toBe(false);
  });

  it("prevents cross-origin navigation", () => {
    expect(prevented(ORIGIN, "http://127.0.0.1:9999/")).toBe(true);
    expect(prevented(ORIGIN, "https://127.0.0.1:7777/")).toBe(true);
    expect(prevented(ORIGIN, "https://evil.example/")).toBe(true);
    expect(prevented(ORIGIN, "file:///etc/passwd")).toBe(true);
    expect(prevented(ORIGIN, "data:text/html,x")).toBe(true);
  });

  it("prevents unparseable targets fail-closed", () => {
    expect(prevented(ORIGIN, "not a url")).toBe(true);
    expect(prevented(ORIGIN, "")).toBe(true);
  });
});
