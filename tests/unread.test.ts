import { beforeEach, describe, expect, it } from "vitest";
import { Unread, type Seen } from "../src/web/unread.ts";

const s = (id: string, activityAt: number): Seen => ({ id, activityAt });
const vis = (...ids: string[]) => new Set(ids);

describe("未读角标", () => {
  let u: Unread;
  beforeEach(() => {
    u = new Unread();
  });

  it("页面刚打开时所有会话都算已看过——后台跑着的活不该一进来全是黄点", () => {
    const list = [s("a", 1000), s("b", 2000)];
    u.seed(list);
    expect(u.isUnread(list[0], vis())).toBe(false);
    expect(u.isUnread(list[1], vis())).toBe(false);
  });

  it("正看着的会话有新输出也不算未读", () => {
    u.seed([s("a", 1000)]);
    expect(u.isUnread(s("a", 9999), vis("a"))).toBe(false);
  });

  it("切走之后来的新输出才算未读", () => {
    const before = [s("a", 1000)];
    u.seed(before);
    u.markSeen(before, vis("a"));
    expect(u.isUnread(s("a", 1000), vis())).toBe(false);
    expect(u.isUnread(s("a", 1500), vis())).toBe(true);
  });

  it("看过之后水位会推进，旧的输出不会再亮一次", () => {
    u.seed([s("a", 1000)]);
    u.markSeen([s("a", 5000)], vis("a")); // 看着它的时候刷了一堆
    expect(u.isUnread(s("a", 5000), vis())).toBe(false); // 切走，不该是未读
    expect(u.isUnread(s("a", 5001), vis())).toBe(true); // 又来了新的
  });

  it("水位只跟服务端时钟走——浏览器时钟偏快偏慢都不影响", () => {
    // 服务端时钟远快于浏览器：老实现会把 lastSeen 记成小得多的 Date.now()，
    // 于是看过的会话切走就永久亮黄点
    const ahead = [s("a", 9_000_000_000_000)];
    u.seed(ahead);
    u.markSeen(ahead, vis("a"));
    expect(u.isUnread(ahead[0], vis())).toBe(false);

    // 浏览器时钟远快于服务端：老实现会把 lastSeen 记成大得多的值，
    // 于是真有新输出也不亮
    const behind = [s("b", 1)];
    u.seed(behind);
    u.markSeen(behind, vis("b"));
    expect(u.isUnread(s("b", 2), vis())).toBe(true);
  });

  it("会话没了就把水位一起丢掉", () => {
    u.seed([s("a", 5000)]);
    u.prune(new Set());
    expect(u.isUnread(s("a", 1), vis())).toBe(true); // 记录已清，当新会话看待
  });
});
