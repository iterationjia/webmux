/**
 * 未读角标。抽出来是为了能单测——它踩过一个很隐蔽的坑（T-29）：
 *
 * activityAt 来自 tmux 的 window_activity，是**服务端时钟**。lastSeen 如果记
 * `Date.now()`（浏览器时钟），两者就是在跨机器比较两个不同的时钟：
 *   - 服务端快于浏览器 → 看过的会话切走就永久亮黄点
 *   - 浏览器快于服务端 → 真有新输出也不亮
 * 所以 lastSeen 存的必须是**那个会话自己的 activityAt**，全程只和服务端时钟比。
 */

export interface Seen {
  id: string;
  activityAt: number;
}

export class Unread {
  private lastSeen = new Map<string, number>();

  /**
   * 页面刚打开时把所有会话都记成「已看过」。不这么做的话，后台跑着的会话
   * 一进来全是未读角标——那不是提醒，那是噪音。只有加载之后的新输出才算数。
   */
  seed(surfaces: readonly Seen[]): void {
    for (const s of surfaces) this.lastSeen.set(s.id, s.activityAt);
  }

  /** 正被看着的会话，随时把「看到哪儿了」推进到它当前的 activityAt。 */
  markSeen(surfaces: readonly Seen[], visible: ReadonlySet<string>): void {
    for (const s of surfaces) {
      if (visible.has(s.id)) this.lastSeen.set(s.id, s.activityAt);
    }
  }

  isUnread(s: Seen, visible: ReadonlySet<string>): boolean {
    return !visible.has(s.id) && s.activityAt > (this.lastSeen.get(s.id) ?? 0);
  }

  /** 会话没了就把记录一起丢掉，否则同名 id 复用时会带着旧水位。 */
  prune(alive: ReadonlySet<string>): void {
    for (const id of [...this.lastSeen.keys()]) {
      if (!alive.has(id)) this.lastSeen.delete(id);
    }
  }
}
