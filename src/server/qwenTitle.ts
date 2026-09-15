/**
 * qwen-code 的会话话题。
 *
 * qwen-code 不把话题写进 pane title，只写死 `Qwen - <目录名>`，同一个目录下开
 * 几个就全是一模一样的标签。但话题在它自己的会话文件里躺着：
 *
 *   ~/.qwen/projects/<slug>/chats/
 *     <session_id>.runtime.json   # { schema_version, pid, session_id, work_dir, started_at }
 *     <session_id>.jsonl          # 逐行 JSON，首条 type=user && provenance=real_user 就是话题
 *
 * 这里把「哪个 pane 对应哪个会话文件」认出来，再把首句话捞回来当标题。
 */

import type { Dirent } from "node:fs";
import { open, readdir, readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 侧栏是轮询的，整轮扫盘结果缓存这么久，别每次都去翻目录。 */
const SCAN_TTL = 2000;
/** 首条用户消息一定在开头，定长读这么多就够，别把整个 jsonl 读进内存。 */
const HEAD_BYTES = 64 * 1024;
const MAX_TOPIC = 32;

export interface QwenRuntime {
  pid: number;
  sessionId: string;
  workDir: string;
  startedAt: string;
  jsonlPath: string;
}

/**
 * cwd 转 project 目录名：**所有**非字母数字字符转 `-`，点号也不例外
 * （`/home/guozengjia.gzj` → `-home-guozengjia-gzj`），不是简单的斜杠转 `-`。
 *
 * 只作为规则留着备用 —— 定位会话靠的是 tty，不是这个（见 T-30）。
 */
export function qwenProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * 是不是一个 qwen-code 的 pane。`command === "node"` 且自报标题是 `Qwen - xxx`。
 * 传进来的标题要先过 `stripDecor()`，否则前面挂了状态字符就匹配不上。
 */
export function isQwenPane(command: string, strippedPaneTitle: string): boolean {
  return command === "node" && /^Qwen\s+-/.test(strippedPaneTitle);
}

/** 字段缺失或坏 JSON 一律当没有，绝不半信半疑地往下走。 */
export function parseRuntime(raw: string, jsonlPath: string): QwenRuntime | null {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const pid = obj.pid;
  const sessionId = obj.session_id;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof sessionId !== "string" || !sessionId) return null;
  return {
    pid,
    sessionId,
    workDir: typeof obj.work_dir === "string" ? obj.work_dir : "",
    startedAt: typeof obj.started_at === "string" ? obj.started_at : "",
    jsonlPath,
  };
}

function textOf(message: any): string {
  if (!message) return "";
  // 老格式：content 直接是裸字符串
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.parts)) {
    return message.parts
      .map((p: any) => (p && typeof p.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

/**
 * 从 jsonl 开头一段里捞第一条真人发的消息。
 *
 * 前面可能垫着 system／工具调用记录，要跳过；末尾那行多半被 HEAD_BYTES 截断成
 * 半个 JSON，**跳过就好，不能抛** —— 为了半行把整个标题解析废掉不值当。
 */
export function firstUserText(chunk: string): string | null {
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // 被截断的半行
    }
    if (!rec || rec.type !== "user") continue;
    const provenance = rec.provenance ?? rec.message?.provenance;
    if (provenance !== "real_user") continue;
    const text = textOf(rec.message).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return null;
}

function clamp(s: string): string {
  const t = s.trim();
  return t.length > MAX_TOPIC ? t.slice(0, MAX_TOPIC - 1) + "…" : t;
}

/** EPERM 意味着进程在、只是不归我们管，那也算活着。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

export interface QwenTitlesOptions {
  /** 测试里注入临时目录用。 */
  root?: string;
}

export class QwenTitles {
  private readonly root: string;
  /** sessionId → 话题。首条消息一旦落盘就不再变，可以永久缓存。 */
  private readonly topics = new Map<string, string>();
  private scanned: QwenRuntime[] | null = null;
  private scannedAt = 0;

  constructor(opts: QwenTitlesOptions = {}) {
    this.root = opts.root ?? join(homedir(), ".qwen", "projects");
  }

  /**
   * 给一个 pane 找它的话题，找不到返回 null（前端退回静态标题）。
   *
   * `cwd` 只是调用方顺手带的上下文，**不参与定位** —— 见 T-30。
   */
  async resolve(cwd: string, paneTty: string): Promise<string | null> {
    if (!paneTty) return null;
    const runtimes = await this.scan();
    if (!runtimes.length) return null;
    const hit = await this.pickByTty(runtimes, paneTty);
    if (!hit) return null; // 对不上就认输，绝不拿「最近启动的那个」兜底
    return await this.topic(hit);
  }

  /** 全 project 扫一遍活着的 runtime，整轮缓存 SCAN_TTL。 */
  private async scan(): Promise<QwenRuntime[]> {
    const now = Date.now();
    if (this.scanned && now - this.scannedAt < SCAN_TTL) return this.scanned;

    const out: QwenRuntime[] = [];
    let projects: Dirent[];
    try {
      projects = await readdir(this.root, { withFileTypes: true });
    } catch {
      projects = []; // ~/.qwen/projects 不存在是正常情况，不是故障
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const chats = join(this.root, project.name, "chats");
      let files: string[];
      try {
        files = await readdir(chats);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".runtime.json")) continue;
        let raw: string;
        try {
          raw = await readFile(join(chats, file), "utf8");
        } catch {
          continue;
        }
        const jsonl = join(chats, file.replace(/\.runtime\.json$/, ".jsonl"));
        const info = parseRuntime(raw, jsonl);
        if (!info || !alive(info.pid)) continue;
        out.push(info);
      }
    }

    this.scanned = out;
    this.scannedAt = now;
    return out;
  }

  /**
   * 按 tty 反查 —— 这是 pane 和 qwen 进程之间唯一可靠的绑定。
   * 不能按 cwd：进程的 cwd 是启动那一刻的，用户在 pane 里随时能 `cd`。
   */
  private async pickByTty(
    runtimes: QwenRuntime[],
    paneTty: string,
  ): Promise<QwenRuntime | null> {
    for (const r of runtimes) {
      let stdin: string;
      try {
        stdin = await readlink(`/proc/${r.pid}/fd/0`);
      } catch {
        continue;
      }
      if (stdin === paneTty) return r;
    }
    return null;
  }

  private async topic(r: QwenRuntime): Promise<string | null> {
    const cached = this.topics.get(r.sessionId);
    if (cached) return cached;

    let fh;
    try {
      fh = await open(r.jsonlPath, "r");
    } catch {
      return null;
    }
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      const found = firstUserText(buf.subarray(0, bytesRead).toString("utf8"));
      if (!found) return null; // 还没说话；**不缓存 null**，下轮轮询再看
      const topic = clamp(found);
      this.topics.set(r.sessionId, topic);
      return topic;
    } finally {
      await fh.close();
    }
  }
}
