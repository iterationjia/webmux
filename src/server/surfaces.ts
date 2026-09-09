import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { basename } from "node:path";
import type { Config } from "./config.ts";
import { Tmux, type TmuxSession } from "./tmux.ts";

/** 忘了关的会话会一直攒着，每个都是常驻 shell。 */
export const MAX_SURFACES = 100;
const ID_BYTES = 4;
const MAX_AUTO_LABEL = 32;

const SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "csh"]);

export interface Surface {
  id: string;
  title: string;
  pinned: boolean;
  createdAt: number;
  activityAt: number;
  attached: number;
  command: string;
  cwd: string;
  dead: boolean;
}

export class SurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceError";
  }
}

/** surface id 必须定长 —— tmux 的 -t 在部分命令上做前缀模糊匹配（见 T-4）。 */
export const newId = (): string => randomBytes(ID_BYTES).toString("hex");
export const newWorkspaceId = (): string => "w_" + newId();
export const newLeafId = (): string => "l_" + newId();

function clamp(s: string): string {
  const t = s.trim();
  return t.length > MAX_AUTO_LABEL ? t.slice(0, MAX_AUTO_LABEL - 1) + "…" : t;
}

/**
 * 剥掉开头的装饰字符。Claude Code 这类程序会在会话名前挂 spinner 状态指示
 * （⠂ refactor、✳ 查看项目），那个字符每几百毫秒换一个，不剥的话标签会一直抖，
 * 而且抖动会把事件流的「有没有变化」判断带偏（T-17）。
 * 只剥开头；保留 / ~ . 以防标题本身就是个路径。
 */
export function stripDecor(title: string): string {
  return title.replace(/^[^\p{L}\p{N}/~.]+/u, "").trim() || title.trim();
}

/** 自报标题是不是 shell 自己设的、没信息量的那种。 */
export function isShellChrome(paneTitle: string, cwd: string, host: string): boolean {
  if (!paneTitle) return true;
  if (/^[^@\s]+@[^:\s]+:/.test(paneTitle)) return true; // user@host:path
  if (paneTitle === host || paneTitle === host.split(".")[0]) return true; // T-19
  if (paneTitle === cwd) return true; // 光一个路径
  if (paneTitle === basename(cwd)) return true; // 光一个目录名
  return false;
}

/**
 * 没手动命名时的标题，优先级从高到低：
 *   1. 程序自报的标题（OSC 0/2 → pane_title），前提是它「有信息量」
 *   2. 正在跑的命令名（vim / node / python3），前提是它不是 shell
 *   3. 当前目录名 —— 「在哪」比「是 bash」有信息量
 *   4. 都取不到就退回短 id
 *
 * ⚠️ 第 1 条只看标题本身有没有信息量，不看在跑什么命令。曾经的判据是「有非 shell
 * 的程序占着终端才采信」，那是错的：Claude Code 跑起来之后 pane_current_command
 * 仍然是 bash（它不是前台进程组的领导），于是真正的会话名被那条判据挡了个正着（T-18）。
 */
export function autoLabel(
  command: string,
  cwd: string,
  id: string,
  paneTitle = "",
  host: string = hostname(),
): string {
  const reported = stripDecor(paneTitle);
  if (reported && !isShellChrome(reported, cwd, host)) return clamp(reported);

  const cmd = command.trim();
  if (cmd && !SHELLS.has(cmd)) return clamp(cmd);

  const dir = basename(cwd);
  if (dir) return clamp(dir);
  if (cwd === "/") return "/";

  return clamp(cmd || id);
}

export function toSurface(s: TmuxSession): Surface {
  const pinned = Boolean(s.title);
  return {
    id: s.id,
    title: pinned ? s.title : autoLabel(s.command, s.cwd, s.id, s.paneTitle),
    pinned,
    createdAt: s.createdAt,
    activityAt: s.activityAt,
    attached: s.attached,
    command: s.command,
    cwd: s.cwd,
    dead: s.dead,
  };
}

export interface CreateOptions {
  title?: string;
  cwd?: string;
  command?: string;
}

export class Surfaces {
  /** 创建必须串行化，否则连按几下新建会各自读到同一份「已有会话」（T-20）。 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly tmux: Tmux,
    private readonly cfg: Config,
  ) {}

  async list(): Promise<Surface[]> {
    return (await this.tmux.listSessions()).map(toSurface);
  }

  async get(id: string): Promise<Surface | null> {
    return (await this.list()).find((s) => s.id === id) ?? null;
  }

  create(opts: CreateOptions = {}): Promise<Surface> {
    const next = this.queue.then(
      () => this.createNow(opts),
      () => this.createNow(opts),
    );
    this.queue = next.catch(() => {}); // 队列本身不能被失败打断
    return next; // 错误照常抛给调用方
  }

  private async createNow(opts: CreateOptions): Promise<Surface> {
    const existing = await this.tmux.listSessions();
    if (existing.length >= MAX_SURFACES) {
      throw new SurfaceError(`会话数已达上限 ${MAX_SURFACES}`);
    }
    const id = newId();
    const name = this.tmux.sessionName(id);
    await this.tmux.newSession(name, opts.cwd || this.cfg.defaultCwd, opts.command);

    // 只有调用方明确给了 title 才写，绝不给新会话写默认标题（INV-7）
    if (opts.title) await this.tmux.setTitle(name, opts.title);

    const made = await this.get(id);
    if (!made) throw new SurfaceError("会话创建后查不到，可能已经退出");
    return made;
  }

  /** title 传空串 = 取消手动命名，标题重新开始跟随。 */
  async rename(id: string, title: string): Promise<void> {
    const name = this.tmux.sessionName(id);
    if (!(await this.tmux.hasSession(name))) {
      throw new SurfaceError("会话不存在或已关闭");
    }
    await this.tmux.setTitle(name, title);
  }

  async close(id: string): Promise<void> {
    const name = this.tmux.sessionName(id);
    if (!(await this.tmux.hasSession(name))) {
      throw new SurfaceError("会话不存在或已关闭");
    }
    await this.tmux.killSession(name);
  }

  /**
   * 一次性迁移：老版本给每个会话写死「终端 N」标题，在新规则下会被当成手动命名，
   * 标题永远不跟随。用户自己起的名字不长这样，按这个模式清是安全的。
   */
  async migrateLegacyTitles(): Promise<void> {
    for (const s of await this.tmux.listSessions()) {
      if (/^终端\s*\d+$/.test(s.title)) {
        try {
          await this.tmux.setTitle(s.name, "");
        } catch {
          /* 忽略 */
        }
      }
    }
  }
}
