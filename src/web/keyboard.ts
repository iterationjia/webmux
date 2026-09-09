/**
 * xterm 默认无法区分 Enter 与 Shift+Enter，两者都送一个 CR，于是在 Claude Code /
 * Codex 里按 Shift+Enter 会直接提交而不是换行。显式改成两者都认的 ESC CR。
 */
export const MULTILINE_ENTER_SEQUENCE = "\x1b\r";

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** 只认单独的 Shift+Enter，别把其它组合也劫持了。 */
export function isMultilineEnter(e: KeyLike): boolean {
  return e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
}
