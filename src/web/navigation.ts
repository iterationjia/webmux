/** 跨工作区会话导航。纯函数，可单测。 */

export interface NavLeaf {
  id: string;
  tabs: string[];
}
export interface NavWorkspace {
  id: string;
  leaves: NavLeaf[];
}
export interface NavTarget {
  workspaceId: string;
  leafId: string;
  surfaceId: string;
}

/** 顺序与 UI 一致：工作区 → 格子 → 标签。 */
export function flattenOrder(workspaces: NavWorkspace[]): NavTarget[] {
  const out: NavTarget[] = [];
  for (const ws of workspaces) {
    for (const leaf of ws.leaves) {
      for (const surfaceId of leaf.tabs) {
        out.push({ workspaceId: ws.id, leafId: leaf.id, surfaceId });
      }
    }
  }
  return out;
}

/**
 * 沿上面那个顺序走一步。当前 workspace 到头就进入下一个，全部走完首尾循环。
 * 只有一个会话时返回 null —— 切了也是原地。
 */
export function step(
  workspaces: NavWorkspace[],
  currentSurfaceId: string | null,
  delta: 1 | -1,
): NavTarget | null {
  const order = flattenOrder(workspaces);
  if (order.length <= 1) return null;
  const at = order.findIndex((t) => t.surfaceId === currentSurfaceId);
  if (at < 0) return order[delta === 1 ? 0 : order.length - 1];
  const next = (at + delta + order.length) % order.length;
  return order[next];
}
