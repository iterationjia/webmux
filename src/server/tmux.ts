import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.ts";

const run = promisify(execFile);

/**
 * 字段分隔符。绝不能用 US(0x1f) 这类真控制字符 —— tmux 的 -F 会把它转义成
 * 字面的 \037 四个字符输出，split 永远切不开（T-1）。
 * ␟ (U+241F) 是「控制字符的图形表示」，tmux 原样吐出，用户又几乎打不出来。
 */
export const SEP = "␟";

export const TITLE_OPTION = "@webmux_title";
const MAX_TITLE = 60;
const MAX_BUFFER = 16 * 1024 * 1024;

/** 一个会话都没有时 tmux 会以「no server running」报错，那不是故障。 */
const NO_SERVER = /no server running|error connecting|failed to connect/i;

export class TmuxError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr = "") {
    super(message);
    this.name = "TmuxError";
    this.stderr = stderr;
  }
}

export interface TmuxSession {
  name: string;
  id: string;
  title: string;
  cwd: string;
  paneTitle: string;
  createdAt: number;
  activityAt: number;
  attached: number;
  command: string;
  dead: boolean;
}

/**
 * 字段顺序不能改，pane_title 必须放最后一个 —— 它是应用随便设的，可能混进任何
 * 字符（分隔符也可能），放中间会把后面的字段挤错位（T-2）。
 *
 * 必须取 window_activity 而不是 session_activity：后者只在会话被 attach/操作时
 * 才更新，用它做未读角标的话，后台跑着的活永远不会提示（T-3）。
 */
const FIELDS = [
  "#{session_name}",
  "#{session_created}",
  "#{window_activity}",
  "#{session_attached}",
  "#{pane_current_command}",
  "#{pane_dead}",
  "#{pane_current_path}",
  `#{${TITLE_OPTION}}`,
  "#{pane_title}",
].join(SEP);

/** 写进 tmux 之前必须清洗：控制字符会撑破按行解析，分隔符会把字段切错位。 */
export function sanitizeTitle(title: string): string {
  return title
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .split(SEP)
    .join(" ")
    .trim()
    .slice(0, MAX_TITLE);
}

export class Tmux {
  constructor(private readonly cfg: Config) {}

  get prefix(): string {
    return this.cfg.prefix;
  }

  sessionName(id: string): string {
    return this.cfg.prefix + id;
  }

  private async exec(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await run(this.cfg.tmuxBin, ["-L", this.cfg.socket, ...args], {
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, LC_ALL: process.env.LC_ALL || "en_US.UTF-8" },
      });
    } catch (err: any) {
      const stderr = String(err?.stderr ?? "");
      throw new TmuxError(
        `tmux ${args[0] ?? ""} 失败: ${stderr.trim() || err?.message || err}`,
        stderr,
      );
    }
  }

  /** attach 的参数单独抽出来，便于单测断言。 */
  attachArgs(name: string): string[] {
    return ["-L", this.cfg.socket, "attach-session", "-t", "=" + name];
  }

  async listSessions(): Promise<TmuxSession[]> {
    let stdout: string;
    try {
      ({ stdout } = await this.exec(["list-sessions", "-F", FIELDS]));
    } catch (err) {
      if (err instanceof TmuxError && NO_SERVER.test(err.stderr)) return [];
      throw err;
    }

    const out: TmuxSession[] = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const parts = line.split(SEP);
      if (parts.length < 9) continue;
      const name = parts[0];
      if (!name.startsWith(this.cfg.prefix)) continue; // INV-8
      out.push({
        name,
        id: name.slice(this.cfg.prefix.length),
        createdAt: Number(parts[1]) * 1000 || 0,
        activityAt: Number(parts[2]) * 1000 || 0,
        attached: Number(parts[3]) || 0,
        command: parts[4] ?? "",
        dead: parts[5] === "1",
        cwd: parts[6] ?? "",
        // 空串保持空串 —— 那是「没手动命名过」的唯一标志（INV-7）
        title: parts[7] ?? "",
        // 兜回被分隔符切碎的 pane_title（T-2）
        paneTitle: parts.slice(8).join(SEP),
      });
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.exec(["has-session", "-t", "=" + name]);
      return true;
    } catch {
      return false;
    }
  }

  async newSession(name: string, cwd: string, command?: string): Promise<void> {
    const args = [
      "new-session",
      "-d", // 服务端不 attach，attach 是浏览器连上来时才发生的事
      "-s",
      name,
      "-c",
      cwd,
      // 不给尺寸的话首屏按 80x24 排版，TUI 全是错行（T-6）
      "-x",
      "120",
      "-y",
      "32",
    ];
    if (command) args.push(command);
    await this.exec(args);
    await this.applyServerDefaults();
  }

  async killSession(name: string): Promise<void> {
    await this.exec(["kill-session", "-t", "=" + name]);
  }

  /**
   * 设成全局而不是逐会话：window-size 是 window option，拿 session 名当 target
   * 会被 tmux 拒（T-8）；而这个 socket 是 webmux 独占的，全局设一次更干净。
   * 幂等；tmux server 还没起来时会失败，忽略即可。
   */
  async applyServerDefaults(): Promise<void> {
    const opts: string[][] = [
      // 多客户端 attach 时按最近活动的那个定尺寸，否则取最小的，
      // 手机一连上来就把桌面端挤成一条缝（T-7）
      ["set-option", "-g", "-w", "window-size", "latest"],
      ["set-option", "-g", "status", "off"], // 网页自己画标签栏
      ["set-option", "-g", "history-limit", String(this.cfg.scrollback * 2)],
      // 不开的话 attach 进 alternate screen，xterm 把滚轮转成方向键，
      // 往上翻出来的是历史命令而不是输出（T-9）。代价见 T-14。
      ["set-option", "-g", "mouse", "on"],
    ];
    for (const args of opts) {
      try {
        await this.exec(args);
      } catch {
        /* server 还没起来，忽略 */
      }
    }
  }

  /**
   * set-option 不认 -t "=name"（T-4），只能传裸名字，靠「id 是定长 hex」
   * 保证前缀匹配不误伤。调用前先自查存在性，否则可能把标题设到别的会话上。
   */
  async setTitle(name: string, title: string): Promise<void> {
    if (!(await this.hasSession(name))) {
      throw new TmuxError(`会话不存在: ${name}`);
    }
    await this.exec(["set-option", "-t", name, TITLE_OPTION, sanitizeTitle(title)]);
  }

  /** capture-pane 同样不认 -t "=name"。回放不是关键路径，失败静默返回空串。 */
  async capturePane(name: string, lines: number): Promise<string> {
    try {
      const { stdout } = await this.exec([
        "capture-pane",
        "-p",
        "-e", // 保留 ANSI 颜色
        "-J", // 把硬折行的长行拼回去
        "-S",
        `-${lines}`,
        "-t",
        name,
      ]);
      return stdout;
    } catch {
      return "";
    }
  }

  async currentPath(name: string): Promise<string> {
    try {
      const { stdout } = await this.exec([
        "display-message",
        "-p",
        "-t",
        name,
        "#{pane_current_path}",
      ]);
      return stdout.trim();
    } catch {
      return "";
    }
  }

  /** attach 的首屏由 tmux 画，可能画成空的 —— 补一次全量重绘。失败无所谓。 */
  async refreshClients(name: string): Promise<void> {
    try {
      const { stdout } = await this.exec([
        "list-clients",
        "-t",
        "=" + name,
        "-F",
        "#{client_name}",
      ]);
      for (const client of stdout.split("\n").filter(Boolean)) {
        try {
          await this.exec(["refresh-client", "-t", client]);
        } catch {
          /* 忽略 */
        }
      }
    } catch {
      /* 忽略 */
    }
  }

  async killServer(): Promise<void> {
    try {
      await this.exec(["kill-server"]);
    } catch {
      /* 本来就没起来 */
    }
  }
}
