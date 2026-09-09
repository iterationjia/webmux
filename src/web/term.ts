import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { wsUrl } from "./api.ts";
import { MULTILINE_ENTER_SEQUENCE, isMultilineEnter } from "./keyboard.ts";
import {
  applyCopyEvent,
  forcedSelectionModifier,
  resolveCopySelection,
  shouldForcePlainSelection,
} from "./clipboard.ts";

/** 后台最多保留多少个还连着的终端 —— 每条连接对应服务端一个 tmux 客户端进程。 */
const MAX_LIVE = 12;

const THEME = {
  background: "#0e1116",
  foreground: "#d6deeb",
  cursor: "#7ee787",
  selectionBackground: "#2c3a4d",
  black: "#0e1116",
  red: "#ff6b6b",
  green: "#7ee787",
  yellow: "#f2cc60",
  blue: "#79b8ff",
  magenta: "#d2a8ff",
  cyan: "#76e3ea",
  white: "#d6deeb",
};

export class TermView {
  readonly el: HTMLDivElement;
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  readonly search = new SearchAddon();
  private ws: WebSocket | null = null;
  private opened = false;
  lastShownAt = 0;
  onImagePaste: ((mime: string, base64: string) => void) | null = null;

  constructor(readonly surfaceId: string) {
    this.el = document.createElement("div");
    this.el.className = "term";

    this.term = new Terminal({
      // 回退链要尽量长：没有真等宽字体时 xterm 会按最宽字符定格宽，
      // 窄字符之间就被拉开一大截
      fontFamily:
        '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, ' +
        'Consolas, "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      // Mac 上强制选择靠 Option，必须显式打开（T-15）
      macOptionClickForcesSelection: true,
      scrollback: 5000, // 服务端有 tmux history-limit 兜底
      allowProposedApi: true,
      theme: THEME,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon());

    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (isMultilineEnter(e)) {
        e.preventDefault();
        this.send(MULTILINE_ENTER_SEQUENCE);
        return false;
      }
      return true;
    });

    this.term.onData((d) => this.send(d));
    this.wireSelection();
  }

  private send(data: string): void {
    // 二进制帧 = 键盘输入（文本帧是控制消息）
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(new TextEncoder().encode(data));
    }
  }

  /**
   * tmux 开了 mouse on 之后普通拖拽会被发给 tmux，怎么拖都选不中（T-14）。
   * 捕获阶段把真实的无修饰左键换成一份带「强制选择」修饰键的合成事件，
   * 后续 mousemove/mouseup 由 xterm 的 SelectionService 自己接管。
   */
  private wireSelection(): void {
    this.el.addEventListener(
      "mousedown",
      (e) => {
        if (!e.isTrusted || !shouldForcePlainSelection(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const mod = forcedSelectionModifier(navigator.platform || navigator.userAgent);
        e.target?.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            clientX: e.clientX,
            clientY: e.clientY,
            button: 0,
            buttons: 1,
            ...mod,
          }),
        );
      },
      true,
    );

    this.el.addEventListener("copy", (e) => {
      const sel = resolveCopySelection(
        this.term.getSelection(),
        window.getSelection(),
        this.el,
      );
      applyCopyEvent(e as unknown as any, sel);
    });
  }

  get selection(): string {
    return resolveCopySelection(this.term.getSelection(), window.getSelection(), this.el);
  }

  /**
   * 顺序不能改：必须先量好尺寸再连。挂载这一帧容器还没有尺寸，xterm 仍是默认
   * 80x24；用这个尺寸 attach，tmux 会先按 80x24 画一屏，等 fit 之后的 resize
   * 到达再重画一次 —— 那次重绘会把刚回灌的历史整屏抹成空白（T-13）。
   */
  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
    if (!this.opened) {
      this.term.open(this.el);
      this.opened = true;
    }
    this.lastShownAt = Date.now();
    this.scheduleAttach();
  }

  /**
   * rAF 保证「先量好尺寸再连」（T-13），但隐藏标签页里 Chrome 压根不跑 rAF ——
   * 只挂 rAF 的话，在后台标签页里打开 webmux，每个终端都停在默认 80x24 且永远
   * 不连接，看起来就是一片空白（T-28）。所以再挂一个定时器兜底，谁先到谁执行。
   */
  private scheduleAttach(): void {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      this.fitOnly();
      this.connect();
    };
    requestAnimationFrame(go);
    setTimeout(go, 120);
  }

  /** 标签页回到前台：补一次 fit（隐藏时量出来的尺寸可能是错的）并确保连着。 */
  revive(): void {
    this.fitAndResize();
    this.connect();
  }

  unmount(): void {
    this.el.remove(); // 切走不销毁 —— 切回来只是重新挂载，屏幕内容一帧都不用重画
  }

  fitOnly(): void {
    try {
      this.fit.fit();
    } catch {
      /* 容器还没尺寸 */
    }
  }

  fitAndResize(): void {
    this.fitOnly();
    this.sendResize();
  }

  private sendResize(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({ type: "resize", cols: this.term.cols, rows: this.term.rows }),
    );
  }

  get connected(): boolean {
    return (
      this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING
    );
  }

  connect(): void {
    if (this.connected) return;
    const ws = new WebSocket(
      wsUrl("/ws/term", {
        id: this.surfaceId,
        cols: String(this.term.cols),
        rows: String(this.term.rows),
      }),
    );
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      // 服务端会把 tmux 的滚动历史整段回灌，不清的话旧内容和回放叠在一起，
      // 看起来像输出了两遍（T-12）
      this.term.reset();
      this.sendResize();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg?.type === "exit") {
            this.term.writeln(`\r\n\x1b[90m[attach 已退出 code=${msg.exitCode}]\x1b[0m`);
          }
        } catch {
          /* 忽略 */
        }
        return;
      }
      this.term.write(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
    };
    ws.onerror = () => ws.close();
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  focus(): void {
    this.term.focus();
  }

  clear(): void {
    this.term.clear();
  }

  setInputEnabled(on: boolean): void {
    this.term.options.disableStdin = !on;
  }

  paste(text: string): void {
    this.term.paste(text);
  }

  dispose(): void {
    this.disconnect();
    this.term.dispose();
    this.el.remove();
  }
}

/**
 * 实例按 surfaceId 缓存、切走不销毁 —— 这是「切标签像 cmux 一样瞬时」的全部秘密。
 * 重连要新建 WebSocket、拉一遍滚动历史、再 spawn 一个 tmux attach，跨网时这几百
 * 毫秒全看得见。
 */
export class TermPool {
  private views = new Map<string, TermView>();

  get(surfaceId: string): TermView {
    let v = this.views.get(surfaceId);
    if (!v) {
      v = new TermView(surfaceId);
      this.views.set(surfaceId, v);
    }
    return v;
  }

  peek(surfaceId: string): TermView | undefined {
    return this.views.get(surfaceId);
  }

  forEach(fn: (v: TermView) => void): void {
    this.views.forEach(fn);
  }

  setInputEnabled(on: boolean): void {
    this.views.forEach((v) => v.setInputEnabled(on));
  }

  /** 超过上限就把最久没看的断掉，它下次被切到时再连。断掉不丢东西——会话活在 tmux 里。 */
  reap(visible: Set<string>): void {
    const live = [...this.views.values()].filter((v) => v.connected);
    if (live.length <= MAX_LIVE) return;
    live
      .filter((v) => !visible.has(v.surfaceId))
      .sort((a, b) => a.lastShownAt - b.lastShownAt)
      .slice(0, live.length - MAX_LIVE)
      .forEach((v) => v.disconnect());
  }

  /** 会话没了的连视图一起 dispose。 */
  prune(alive: Set<string>): void {
    for (const [id, v] of [...this.views]) {
      if (!alive.has(id)) {
        v.dispose();
        this.views.delete(id);
      }
    }
  }
}
