/**
 * 布局树：纯函数，不碰 IO —— 这样能被完整单测，不用为了测试去起 tmux。
 *
 * 为什么是二叉 split 而不是「一行 N 个」：拖分割线时只需调整一个 ratio，
 * 不用在 N 个兄弟之间做等比重分配。嵌套两层就能表达任意 IDE 式布局。
 */

export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;

export type Direction = "row" | "col";

export interface LeafNode {
  kind: "leaf";
  id: string;
  tabs: string[];
  active: string | null;
}

export interface SplitNode {
  kind: "split";
  id: string;
  dir: Direction;
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

export type LayoutNode = LeafNode | SplitNode;

export interface Workspace {
  id: string;
  name: string;
  layout: LayoutNode;
  focusedLeaf: string;
}

export function makeLeaf(id: string, tabs: string[] = []): LeafNode {
  return { kind: "leaf", id, tabs: [...tabs], active: tabs[0] ?? null };
}

export function* walk(node: LayoutNode): Generator<LayoutNode> {
  yield node;
  if (node.kind === "split") {
    yield* walk(node.a);
    yield* walk(node.b);
  }
}

export function leaves(node: LayoutNode): LeafNode[] {
  const out: LeafNode[] = [];
  for (const n of walk(node)) if (n.kind === "leaf") out.push(n);
  return out;
}

export function findLeaf(node: LayoutNode, leafId: string): LeafNode | null {
  for (const n of walk(node)) if (n.kind === "leaf" && n.id === leafId) return n;
  return null;
}

export function findSplit(node: LayoutNode, splitId: string): SplitNode | null {
  for (const n of walk(node)) if (n.kind === "split" && n.id === splitId) return n;
  return null;
}

/** 摊平出树里所有的 surface id，用于和 tmux 对账。 */
export function surfaceIds(node: LayoutNode): string[] {
  return leaves(node).flatMap((l) => l.tabs);
}

export function leafOfSurface(node: LayoutNode, surfaceId: string): LeafNode | null {
  for (const l of leaves(node)) if (l.tabs.includes(surfaceId)) return l;
  return null;
}

/** 把某个叶子切成两半：原格子留在 a，新格子在 b。 */
export function splitLeaf(
  root: LayoutNode,
  leafId: string,
  dir: Direction,
  newLeafId: string,
  newSurfaceId: string,
): LayoutNode {
  const replace = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") {
      if (node.id !== leafId) return node;
      return {
        kind: "split",
        id: "s_" + newLeafId,
        dir,
        ratio: 0.5,
        a: node,
        b: makeLeaf(newLeafId, [newSurfaceId]),
      };
    }
    return { ...node, a: replace(node.a), b: replace(node.b) };
  };
  return replace(root);
}

/** 关格子：兄弟提上来顶替父节点。根是叶子时原样返回（INV-3）。 */
export function removeLeaf(root: LayoutNode, leafId: string): LayoutNode {
  if (root.kind === "leaf") return root;
  const drop = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") return node;
    if (node.a.kind === "leaf" && node.a.id === leafId) return drop(node.b);
    if (node.b.kind === "leaf" && node.b.id === leafId) return drop(node.a);
    return { ...node, a: drop(node.a), b: drop(node.b) };
  };
  return drop(root);
}

/** 比例夹在 0.1~0.9 之间，防止把一边拖没。 */
export function setRatio(root: LayoutNode, splitId: string, ratio: number): LayoutNode {
  const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
  const apply = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") return node;
    if (node.id === splitId) return { ...node, ratio: clamped, a: node.a, b: node.b };
    return { ...node, a: apply(node.a), b: apply(node.b) };
  };
  return apply(root);
}

/** 追加并切过去；已存在时只切过去，不重复添加。 */
export function addTab(root: LayoutNode, leafId: string, surfaceId: string): LayoutNode {
  const apply = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") {
      if (node.id !== leafId) return node;
      if (node.tabs.includes(surfaceId)) return { ...node, active: surfaceId };
      return { ...node, tabs: [...node.tabs, surfaceId], active: surfaceId };
    }
    return { ...node, a: apply(node.a), b: apply(node.b) };
  };
  return apply(root);
}

/** 只认这个格子里有的 tab。 */
export function activateTab(
  root: LayoutNode,
  leafId: string,
  surfaceId: string,
): LayoutNode {
  const apply = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") {
      if (node.id !== leafId || !node.tabs.includes(surfaceId)) return node;
      return { ...node, active: surfaceId };
    }
    return { ...node, a: apply(node.a), b: apply(node.b) };
  };
  return apply(root);
}

/** 空掉的格子收起来，兄弟顶上；但至少留一个叶子（INV-3）。 */
function collapseEmpty(node: LayoutNode): LayoutNode {
  if (node.kind === "leaf") return node;
  const a = collapseEmpty(node.a);
  const b = collapseEmpty(node.b);
  const aEmpty = a.kind === "leaf" && a.tabs.length === 0;
  const bEmpty = b.kind === "leaf" && b.tabs.length === 0;
  if (aEmpty && bEmpty) return a;
  if (aEmpty) return b;
  if (bEmpty) return a;
  return { ...node, a, b };
}

function dropTabs(node: LayoutNode, keep: (id: string) => boolean): LayoutNode {
  if (node.kind === "leaf") {
    const tabs = node.tabs.filter(keep);
    if (tabs.length === node.tabs.length) return node;
    // 摘的是当前 tab 时顺延到 tabs[0]
    const active =
      node.active && tabs.includes(node.active) ? node.active : tabs[0] ?? null;
    return { ...node, tabs, active };
  }
  return { ...node, a: dropTabs(node.a, keep), b: dropTabs(node.b, keep) };
}

/**
 * 从整棵树摘掉一个标签。和 addTab 分开写是因为拖拽移动是「这边摘掉、那边挂上」
 * 两步，跨工作区移动时这两步作用在两棵不同的树上。
 */
export function removeTab(root: LayoutNode, surfaceId: string): LayoutNode {
  if (!surfaceIds(root).includes(surfaceId)) return root;
  return collapseEmpty(dropTabs(root, (id) => id !== surfaceId));
}

/** 与 tmux 对账：摘掉指向已消失会话的 tab。最后一个叶子允许是空的。 */
export function reconcile(root: LayoutNode, alive: Set<string>): LayoutNode {
  return collapseEmpty(dropTabs(root, (id) => alive.has(id)));
}
