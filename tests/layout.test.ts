import { describe, expect, it } from "vitest";
import {
  activateTab,
  addTab,
  leaves,
  makeLeaf,
  reconcile,
  removeLeaf,
  removeTab,
  setRatio,
  splitLeaf,
  surfaceIds,
  type LayoutNode,
  type SplitNode,
} from "../src/server/layout.ts";

const leaf = (id: string, tabs: string[] = []) => makeLeaf(id, tabs);
const asSplit = (n: LayoutNode) => n as SplitNode;

describe("布局树", () => {
  it("makeLeaf 默认把第一个 tab 设为当前", () => {
    expect(leaf("l1", ["s1", "s2"]).active).toBe("s1");
    expect(leaf("l1").active).toBeNull();
  });

  it("split 之后原格子在 a、新格子在 b", () => {
    const root = asSplit(splitLeaf(leaf("l1", ["s1"]), "l1", "row", "l2", "s2"));
    expect(root.kind).toBe("split");
    expect(root.id).toBe("s_l2");
    expect(root.ratio).toBe(0.5);
    expect((root.a as any).id).toBe("l1");
    expect((root.b as any).id).toBe("l2");
    expect((root.b as any).tabs).toEqual(["s2"]);
  });

  it("嵌套 split：能对新格子再切一刀", () => {
    let root = splitLeaf(leaf("l1", ["s1"]), "l1", "row", "l2", "s2");
    root = splitLeaf(root, "l2", "col", "l3", "s3");
    expect(leaves(root).map((l) => l.id)).toEqual(["l1", "l2", "l3"]);
    expect(surfaceIds(root)).toEqual(["s1", "s2", "s3"]);
  });

  it("removeLeaf 把兄弟提上来顶替父节点", () => {
    const root = splitLeaf(leaf("l1", ["s1"]), "l1", "row", "l2", "s2");
    const after = removeLeaf(root, "l2");
    expect(after.kind).toBe("leaf");
    expect((after as any).id).toBe("l1");
  });

  it("最后一个格子删不掉——树永远至少有一个叶子", () => {
    const root = leaf("l1", ["s1"]);
    expect(removeLeaf(root, "l1")).toBe(root);
  });

  it("setRatio 夹在 0.1~0.9 之间，防止把一边拖没", () => {
    const root = splitLeaf(leaf("l1", ["s1"]), "l1", "row", "l2", "s2");
    expect(asSplit(setRatio(root, "s_l2", 0.001)).ratio).toBe(0.1);
    expect(asSplit(setRatio(root, "s_l2", 5)).ratio).toBe(0.9);
    expect(asSplit(setRatio(root, "s_l2", 0.3)).ratio).toBe(0.3);
  });

  it("addTab 追加并切过去，重复添加只是切过去", () => {
    let root: LayoutNode = leaf("l1", ["s1"]);
    root = addTab(root, "l1", "s2");
    expect((root as any).tabs).toEqual(["s1", "s2"]);
    expect((root as any).active).toBe("s2");
    root = activateTab(root, "l1", "s1");
    root = addTab(root, "l1", "s2");
    expect((root as any).tabs).toEqual(["s1", "s2"]);
    expect((root as any).active).toBe("s2");
  });

  it("activateTab 只认这个格子里有的 tab", () => {
    const root = leaf("l1", ["s1", "s2"]);
    expect((activateTab(root, "l1", "s9") as any).active).toBe("s1");
    expect((activateTab(root, "l9", "s2") as any).active).toBe("s1");
  });

  it("从哪个格子摘都行，当前 tab 会顺延", () => {
    const root = activateTab(leaf("l1", ["s1", "s2", "s3"]), "l1", "s2");
    const after = removeTab(root, "s2");
    expect((after as any).tabs).toEqual(["s1", "s3"]);
    expect((after as any).active).toBe("s1");
  });

  it("摘的不是当前 tab 就不动当前 tab", () => {
    const root = activateTab(leaf("l1", ["s1", "s2", "s3"]), "l1", "s3");
    expect((removeTab(root, "s1") as any).active).toBe("s3");
  });

  it("摘空的格子会被收起来，兄弟顶上", () => {
    const root = splitLeaf(leaf("l1", ["s1"]), "l1", "row", "l2", "s2");
    const after = removeTab(root, "s2");
    expect(after.kind).toBe("leaf");
    expect((after as any).id).toBe("l1");
  });

  it("摘到最后一个也留一个空格子，不会变成空树", () => {
    const after = removeTab(leaf("l1", ["s1"]), "s1");
    expect(after.kind).toBe("leaf");
    expect((after as any).tabs).toEqual([]);
    expect((after as any).active).toBeNull();
  });

  it("树里没有这个 tab 时原样返回", () => {
    const root = leaf("l1", ["s1"]);
    expect(removeTab(root, "s9")).toBe(root);
  });

  it("摘掉指向已消失会话的 tab，并把当前 tab 顺延", () => {
    const root = activateTab(leaf("l1", ["s1", "s2"]), "l1", "s2");
    const after = reconcile(root, new Set(["s1"]));
    expect((after as any).tabs).toEqual(["s1"]);
    expect((after as any).active).toBe("s1");
  });

  it("当前 tab 还活着就不动它", () => {
    const root = activateTab(leaf("l1", ["s1", "s2"]), "l1", "s2");
    expect((reconcile(root, new Set(["s1", "s2"])) as any).active).toBe("s2");
  });

  it("空掉的格子会被收起来，兄弟顶上", () => {
    const root = splitLeaf(leaf("l1", ["s1"]), "l1", "row", "l2", "s2");
    const after = reconcile(root, new Set(["s1"]));
    expect(after.kind).toBe("leaf");
    expect((after as any).id).toBe("l1");
  });

  it("全部会话都没了时留下一个空格子，而不是空树", () => {
    const root = splitLeaf(leaf("l1", ["s1"]), "l1", "row", "l2", "s2");
    const after = reconcile(root, new Set());
    expect(after.kind).toBe("leaf");
    expect((after as any).tabs).toEqual([]);
  });
});
