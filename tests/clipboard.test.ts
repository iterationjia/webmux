import { describe, expect, it, vi } from "vitest";
import {
  applyCopyEvent,
  forcedSelectionModifier,
  resolveCopySelection,
  shouldForcePlainSelection,
} from "../src/web/clipboard.ts";

const term = { contains: (n: any) => n === "inside" };
const dom = (text: string, anchor = "inside", focus = anchor) => ({
  toString: () => text,
  anchorNode: anchor,
  focusNode: focus,
});
const mouse = (over: Partial<any> = {}) => ({
  button: 0,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("复制", () => {
  it("把 xterm 选中的原文同步写入 text/plain，并阻止浏览器复制隐藏 textarea", () => {
    const setData = vi.fn();
    const preventDefault = vi.fn();
    const ok = applyCopyEvent({ clipboardData: { setData }, preventDefault }, "hello");
    expect(ok).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "hello");
    expect(preventDefault).toHaveBeenCalled();
  });

  it("没有选择内容时不碰剪贴板——Ctrl+C 仍应放行给终端当 SIGINT", () => {
    const setData = vi.fn();
    const preventDefault = vi.fn();
    expect(applyCopyEvent({ clipboardData: { setData }, preventDefault }, "")).toBe(false);
    expect(setData).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("浏览器不给 clipboardData 时安全降级，不假装复制成功", () => {
    const preventDefault = vi.fn();
    expect(applyCopyEvent({ clipboardData: null, preventDefault }, "hello")).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("普通拖拽形成浏览器原生选择时也能复制", () => {
    expect(resolveCopySelection("", dom("拖出来的"), term)).toBe("拖出来的");
  });

  it("xterm 选择优先于浏览器原生选择", () => {
    expect(resolveCopySelection("xterm 的", dom("DOM 的"), term)).toBe("xterm 的");
  });

  it("页面其它区域的 DOM 选择不能劫持终端的 Ctrl+C", () => {
    expect(resolveCopySelection("", dom("别处的", "outside"), term)).toBe("");
    expect(resolveCopySelection("", dom("半个", "inside", "outside"), term)).toBe("");
  });

  it("Mac 用 Option、其它平台用 Shift 强制 xterm 选择", () => {
    expect(forcedSelectionModifier("MacIntel")).toEqual({ altKey: true });
    expect(forcedSelectionModifier("Linux x86_64")).toEqual({ shiftKey: true });
  });

  it("只有无修饰键左键才被转换成普通文本选择", () => {
    expect(shouldForcePlainSelection(mouse())).toBe(true);
    expect(shouldForcePlainSelection(mouse({ button: 2 }))).toBe(false);
    expect(shouldForcePlainSelection(mouse({ shiftKey: true }))).toBe(false);
    expect(shouldForcePlainSelection(mouse({ altKey: true }))).toBe(false);
    expect(shouldForcePlainSelection(mouse({ ctrlKey: true }))).toBe(false);
  });
});
