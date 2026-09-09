import type { Surface, Surfaces } from "./surfaces.ts";

const INTERVAL = 1000;

type Listener = (surfaces: Surface[]) => void;

/**
 * 轮询而不是 tmux 的 monitor-activity（那个要写进用户配置，语义也只到
 * 「非当前窗口有动静」）。一次 list-sessions 就够画出「有新输出 / 已退出 /
 * 正在跑什么」三种角标，还不污染任何 tmux 配置。
 *
 * 后端只推事实，不推「未读」—— 哪个标签正被人看着只有前端知道（INV-9）。
 */
export class Activity {
  private listeners = new Set<Listener>();
  private timer: NodeJS.Timeout | null = null;
  private digest = "";

  constructor(private readonly surfaces: Surfaces) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    this.start();
    void this.tick(true); // 订阅即推一份当前快照，不用等下一个周期
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** 写操作完成后立刻推一次，不等下一个轮询周期。 */
  kick(): void {
    void this.tick(true);
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(false), INTERVAL);
    this.timer.unref(); // 别把进程吊住
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(force: boolean): Promise<void> {
    if (this.listeners.size === 0) return;
    let list: Surface[];
    try {
      list = await this.surfaces.list();
    } catch {
      return; // tmux 暂时不可用 → 静默跳过这一轮
    }
    const next = JSON.stringify(list);
    if (!force && next === this.digest) return;
    this.digest = next;
    for (const fn of this.listeners) {
      try {
        fn(list);
      } catch {
        /* 单个订阅者抛错不影响其它人 */
      }
    }
  }
}
