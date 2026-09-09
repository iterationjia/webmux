import { describe, expect, it } from "vitest";
import { MULTILINE_ENTER_SEQUENCE, isMultilineEnter } from "../src/web/keyboard.ts";

const key = (over: Partial<any> = {}) => ({
  key: "Enter",
  shiftKey: true,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...over,
});

describe("Shift+Enter", () => {
  it("Shift+Enter 编码成 Claude Code 与 Codex 都支持的 ESC+CR", () => {
    expect(MULTILINE_ENTER_SEQUENCE).toBe("\x1b\r");
    expect(isMultilineEnter(key())).toBe(true);
  });

  it("只拦截单独的 Shift+Enter", () => {
    expect(isMultilineEnter(key({ shiftKey: false }))).toBe(false);
    expect(isMultilineEnter(key({ ctrlKey: true }))).toBe(false);
    expect(isMultilineEnter(key({ metaKey: true }))).toBe(false);
    expect(isMultilineEnter(key({ altKey: true }))).toBe(false);
    expect(isMultilineEnter(key({ key: "a" }))).toBe(false);
  });
});
