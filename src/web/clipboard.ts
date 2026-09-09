/** 复制与文本选择里可以脱离浏览器单测的那部分。 */

export interface DomSelectionLike {
  toString(): string;
  anchorNode: unknown;
  focusNode: unknown;
}
export interface ContainerLike {
  contains(node: any): boolean;
}
export interface CopyEventLike {
  clipboardData?: { setData(type: string, data: string): void } | null;
  preventDefault(): void;
}
export interface MouseLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * 终端里可能同时存在两套选择：xterm 自己画的选择层，和浏览器原生 DOM 选择。
 * xterm 优先；没有时才认 DOM 选择，且起止两端都必须在这个终端元素内 ——
 * 否则页面别处选中的文字会劫持终端的 Ctrl+C。
 */
export function resolveCopySelection(
  xtermSelection: string,
  dom: DomSelectionLike | null,
  container: ContainerLike,
): string {
  if (xtermSelection && xtermSelection.trim()) return xtermSelection;
  if (!dom) return "";
  const text = dom.toString();
  if (!text.trim()) return "";
  if (!container.contains(dom.anchorNode)) return "";
  if (!container.contains(dom.focusNode)) return "";
  return text;
}

/**
 * 用 copy 事件的 clipboardData 同步写入 —— 这条路属于当前用户手势，不走异步
 * 权限，是最稳的。拿不到 clipboardData 就如实返回 false，别一边吞异常一边
 * preventDefault，那样用户看到的就是「按了复制但什么也没有」（T-16）。
 */
export function applyCopyEvent(event: CopyEventLike, selection: string): boolean {
  if (!selection) return false; // 没选中就放行，让 Ctrl+C 去当 SIGINT
  const cd = event.clipboardData;
  if (!cd) return false;
  cd.setData("text/plain", selection);
  event.preventDefault(); // 别让浏览器去复制 xterm 那个隐藏 textarea
  return true;
}

/** Mac 的 xterm 只认 Option 强制选择，其它平台是 Shift（T-15）。 */
export function forcedSelectionModifier(
  platform: string,
): { altKey: true } | { shiftKey: true } {
  return /mac/i.test(platform) ? { altKey: true } : { shiftKey: true };
}

/**
 * tmux 开了 mouse on 之后普通拖拽会被发给 tmux，用户看起来就是「怎么拖都选不中」。
 * 只有真实的无修饰键左键才转换成强制文本选择；带任意修饰键时放行给 TUI（T-14）。
 */
export function shouldForcePlainSelection(e: MouseLike): boolean {
  return (
    e.button === 0 && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
  );
}
