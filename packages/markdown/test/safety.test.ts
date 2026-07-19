import { describe, expect, it } from "vitest";
import {
  forbiddenUrlScheme,
  isAuthorbotComment,
  parseChapterMarkdown,
  scanSafety,
} from "../src/index.js";

const UUID_A = "0190f27e-1a93-7b61-996a-9f94849d27a8";

function scan(source: string) {
  return scanSafety(parseChapterMarkdown(source).ast);
}

describe("scanSafety raw HTML", () => {
  it("exempts authorbot block markers and delimiter comments", () => {
    const source = [
      `<!-- authorbot:block id="${UUID_A}" -->`,
      "A paragraph.",
      "",
      "<!-- authorbot:original:start -->",
      "Original.",
      "<!-- authorbot:original:end -->",
      "",
    ].join("\n");
    expect(scan(source).rawHtml).toHaveLength(0);
  });

  it("flags raw HTML elements in prose", () => {
    const result = scan("A paragraph with <em>inline html</em> inside.\n\n<div>block html</div>\n");
    expect(result.rawHtml.length).toBeGreaterThanOrEqual(2);
    expect(result.rawHtml.some((f) => f.value.includes("<div>"))).toBe(true);
    expect(result.rawHtml.some((f) => f.value.includes("<em>"))).toBe(true);
  });

  it("flags non-authorbot HTML comments (only authorbot comments are exempt)", () => {
    const result = scan("<!-- an ordinary comment -->\n\nProse.\n");
    expect(result.rawHtml).toHaveLength(1);
  });

  it("does not exempt a node that smuggles HTML after an authorbot comment", () => {
    const result = scan(`<!-- authorbot:block id="${UUID_A}" --><script>x()</script>\n`);
    expect(result.rawHtml).toHaveLength(1);
  });
});

describe("scanSafety URL schemes", () => {
  it("detects javascript: links", () => {
    const result = scan("[click me](javascript:alert(1))\n");
    expect(result.forbiddenUrls).toHaveLength(1);
    expect(result.forbiddenUrls[0]).toMatchObject({ scheme: "javascript", nodeType: "link" });
  });

  it("detects forbidden schemes on images and definitions", () => {
    const source = [
      "![pic](data:image/png;base64,AAAA)",
      "",
      "[ref]: vbscript:evil",
      "",
    ].join("\n");
    const result = scan(source);
    expect(result.forbiddenUrls.map((f) => [f.nodeType, f.scheme])).toEqual([
      ["image", "data"],
      ["definition", "vbscript"],
    ]);
  });

  it("allows http, https, mailto, relative, anchor, and scheme-relative URLs", () => {
    const source = [
      "[a](http://example.com) [b](https://example.com) [c](mailto:joe@example.com)",
      "",
      "[d](/chapters/opening/) [e](../story/outline.yml) [f](#anchor) [g](//example.com/x)",
      "",
    ].join("\n");
    expect(scan(source).forbiddenUrls).toHaveLength(0);
  });

  it("is not fooled by case or embedded control characters", () => {
    expect(forbiddenUrlScheme("JavaScript:alert(1)")).toBe("javascript");
    expect(forbiddenUrlScheme("java\nscript:alert(1)")).toBe("javascript");
    expect(forbiddenUrlScheme(" \thttp://example.com")).toBeNull();
    expect(forbiddenUrlScheme("HTTPS://example.com")).toBeNull();
  });
});

describe("isAuthorbotComment", () => {
  it("accepts exactly one authorbot comment", () => {
    expect(isAuthorbotComment(`<!-- authorbot:block id="${UUID_A}" -->`)).toBe(true);
    expect(isAuthorbotComment("<!-- authorbot:original:start -->")).toBe(true);
    expect(isAuthorbotComment("  <!-- authorbot:original:end -->  ")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isAuthorbotComment("<!-- plain comment -->")).toBe(false);
    expect(isAuthorbotComment("<div>authorbot:</div>")).toBe(false);
    expect(isAuthorbotComment("<!-- authorbot:x --><span>y</span>")).toBe(false);
  });
});
