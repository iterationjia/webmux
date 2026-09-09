import { describe, expect, it } from "vitest";
import { flattenOrder, step, type NavWorkspace } from "../src/web/navigation.ts";

const wss: NavWorkspace[] = [
  { id: "w1", leaves: [{ id: "l1", tabs: ["s1", "s2"] }, { id: "l2", tabs: ["s3"] }] },
  { id: "w2", leaves: [{ id: "l3", tabs: ["s4"] }] },
];

describe("跨工作区导航", () => {
  it("顺序与 UI 一致：工作区 → 格子 → 标签", () => {
    expect(flattenOrder(wss).map((t) => t.surfaceId)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("当前 workspace 到头后进入下一个 workspace", () => {
    expect(step(wss, "s3", 1)).toEqual({ workspaceId: "w2", leafId: "l3", surfaceId: "s4" });
  });

  it("向前切也能跨回上一个 workspace", () => {
    expect(step(wss, "s4", -1)).toEqual({ workspaceId: "w1", leafId: "l2", surfaceId: "s3" });
  });

  it("全部走完后首尾循环", () => {
    expect(step(wss, "s4", 1)?.surfaceId).toBe("s1");
    expect(step(wss, "s1", -1)?.surfaceId).toBe("s4");
  });

  it("只有一个会话时不切换", () => {
    const one: NavWorkspace[] = [{ id: "w1", leaves: [{ id: "l1", tabs: ["s1"] }] }];
    expect(step(one, "s1", 1)).toBeNull();
    expect(step(one, "s1", -1)).toBeNull();
  });
});
