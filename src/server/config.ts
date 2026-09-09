import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  tmuxBin: string;
  socket: string;
  prefix: string;
  host: string;
  port: number;
  token: string;
  defaultCwd: string;
  stateFile: string;
  scrollback: number;
  tlsCert: string;
  tlsKey: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * tmux 可执行文件。SPEC 的默认值是 ~/.local/bin/tmux（原机是用 AppImage 装的），
 * 那个路径不存在时退回 PATH 里的 tmux —— macOS 上 brew 装在 /opt/homebrew/bin。
 */
function defaultTmuxBin(): string {
  const local = join(homedir(), ".local", "bin", "tmux");
  return existsSync(local) ? local : "tmux";
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 端口要单独一个：0 是「让系统随便挑一个」，是合法值，不能当成没填。 */
function port(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME || homedir();
  const cfg: Config = {
    tmuxBin: env.WEBMUX_TMUX || defaultTmuxBin(),
    socket: env.WEBMUX_SOCKET || "webmux",
    prefix: env.WEBMUX_PREFIX || "wm_",
    host: env.WEBMUX_HOST || "127.0.0.1",
    port: port(env.WEBMUX_PORT, 7788),
    token: env.WEBMUX_TOKEN || "",
    defaultCwd: env.WEBMUX_CWD || home,
    stateFile: env.WEBMUX_STATE || join(home, ".webmux", "state.json"),
    scrollback: num(env.WEBMUX_SCROLLBACK, 2000),
    tlsCert: env.WEBMUX_TLS_CERT || "",
    tlsKey: env.WEBMUX_TLS_KEY || "",
  };

  // 这是完整的远程代码执行：监听非回环地址却没有令牌时，拒绝启动，
  // 不给「先跑起来再说」的机会。
  if (!LOOPBACK.has(cfg.host) && !cfg.token) {
    throw new Error(
      `拒绝启动：监听 ${cfg.host}（非回环地址）必须设置 WEBMUX_TOKEN`,
    );
  }
  return cfg;
}

export const isTlsEnabled = (cfg: Config): boolean =>
  Boolean(cfg.tlsCert && cfg.tlsKey);
