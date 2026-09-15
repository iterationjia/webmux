import { mkdtemp, mkdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.ts";
import {
  QwenTitles,
  firstUserText,
  isQwenPane,
  parseRuntime,
  qwenProjectSlug,
} from "../src/server/qwenTitle.ts";
import { Surfaces } from "../src/server/surfaces.ts";
import type { Tmux, TmuxSession } from "../src/server/tmux.ts";

describe("qwenProjectSlug", () => {
  it("所有非字母数字字符转 -", () => {
    expect(qwenProjectSlug("/home/x/Documents/a")).toBe("-home-x-Documents-a");
  });

  it("点号也要转——不是简单的斜杠转 -", () => {
    expect(qwenProjectSlug("/home/guozengjia.gzj")).toBe("-home-guozengjia-gzj");
  });
});

describe("isQwenPane", () => {
  it("node + 「Qwen - xxx」才算", () => {
    expect(isQwenPane("node", "Qwen - autorequirement")).toBe(true);
  });

  it("命令不是 node 的不算", () => {
    expect(isQwenPane("bash", "Qwen - autorequirement")).toBe(false);
  });

  it("node 但标题为空的不算", () => {
    expect(isQwenPane("node", "")).toBe(false);
  });

  it("node 但标题是主机名的不算", () => {
    expect(isQwenPane("node", "build-node-07.example.internal")).toBe(false);
  });

  it("Claude 的中文话题标题不算", () => {
    expect(isQwenPane("node", "重构布局树")).toBe(false);
  });
});

describe("parseRuntime", () => {
  const good = JSON.stringify({
    schema_version: 1,
    pid: 4242,
    session_id: "s-abc",
    work_dir: "/home/x/proj",
    started_at: "2026-09-15T10:00:00Z",
  });

  it("合法 JSON 解析出全字段", () => {
    const r = parseRuntime(good, "/chats/s-abc.jsonl")!;
    expect(r).toBeTruthy();
    expect(r.pid).toBe(4242);
    expect(r.sessionId).toBe("s-abc");
    expect(r.workDir).toBe("/home/x/proj");
    expect(r.jsonlPath).toBe("/chats/s-abc.jsonl");
  });

  it("缺 pid 返回 null", () => {
    expect(parseRuntime(JSON.stringify({ session_id: "s" }), "x")).toBe(null);
  });

  it("缺 session_id 返回 null", () => {
    expect(parseRuntime(JSON.stringify({ pid: 1 }), "x")).toBe(null);
  });

  it("坏 JSON 返回 null 而不是抛", () => {
    expect(parseRuntime("{不是 json", "x")).toBe(null);
  });
});

describe("firstUserText", () => {
  const line = (o: unknown) => JSON.stringify(o) + "\n";

  it("跳过前面的 system／工具消息，取首条真人发言", () => {
    const chunk =
      line({ type: "system", message: { parts: [{ text: "你是一个助手" }] } }) +
      line({ type: "user", provenance: "tool", message: { parts: [{ text: "工具回执" }] } }) +
      line({ type: "user", provenance: "real_user", message: { parts: [{ text: "帮我看下登录" }] } }) +
      line({ type: "user", provenance: "real_user", message: { parts: [{ text: "第二句" }] } });
    expect(firstUserText(chunk)).toBe("帮我看下登录");
  });

  it("多 parts 拼接，换行压成单空格", () => {
    const chunk = line({
      type: "user",
      provenance: "real_user",
      message: { parts: [{ text: "第一段\n\n" }, { text: "  第二段" }] },
    });
    expect(firstUserText(chunk)).toBe("第一段 第二段");
  });

  it("兼容 content 是裸字符串的老格式", () => {
    const chunk = line({ type: "user", provenance: "real_user", message: { content: "老格式话题" } });
    expect(firstUserText(chunk)).toBe("老格式话题");
  });

  it("末尾被截断的半行要跳过，不能抛", () => {
    const chunk =
      line({ type: "user", provenance: "real_user", message: { parts: [{ text: "完整的一句" }] } }) +
      '{"type":"user","provenance":"real_user","message":{"parts":[{"te';
    expect(firstUserText(chunk)).toBe("完整的一句");
  });

  it("只有截断的半行 / 全空消息 → null", () => {
    expect(firstUserText('{"type":"user","prov')).toBe(null);
    expect(
      firstUserText(line({ type: "user", provenance: "real_user", message: { parts: [{ text: "   " }] } })),
    ).toBe(null);
  });
});

describe("QwenTitles.resolve", () => {
  let root: string;
  let tty: string;

  const runtime = (pid: number, sessionId: string) =>
    JSON.stringify({ schema_version: 1, pid, session_id: sessionId, work_dir: "/w" });

  const userLine = (text: string) =>
    JSON.stringify({ type: "user", provenance: "real_user", message: { parts: [{ text }] } }) + "\n";

  /** 在 root 下造一个 project，返回 chats 目录。 */
  async function project(slug: string): Promise<string> {
    const chats = join(root, slug, "chats");
    await mkdir(chats, { recursive: true });
    return chats;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "webmux-qwen-"));
    // 拿当前进程自己的 stdin 造一对真实可对上的 pid/tty
    tty = await readlink("/proc/self/fd/0");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("活进程 + tty 对上 → 拿到首条消息，截到 32 字", async () => {
    const chats = await project("-live");
    await writeFile(join(chats, "s1.runtime.json"), runtime(process.pid, "s1"));
    await writeFile(join(chats, "s1.jsonl"), userLine("话".repeat(50)));

    const topic = await new QwenTitles({ root }).resolve("/w", tty);
    expect(topic).toBe("话".repeat(31) + "…");
    expect(topic!.length).toBe(32);
  });

  it("进程已死 → null", async () => {
    const solo = await mkdtemp(join(tmpdir(), "webmux-qwen-dead-"));
    const chats = join(solo, "-dead", "chats");
    await mkdir(chats, { recursive: true });
    // PID 上限之上，一定不存在
    await writeFile(join(chats, "s2.runtime.json"), runtime(0x7fffffff, "s2"));
    await writeFile(join(chats, "s2.jsonl"), userLine("死了的会话"));

    await expect(new QwenTitles({ root: solo }).resolve("/w", tty)).resolves.toBe(null);
    await rm(solo, { recursive: true, force: true });
  });

  it("projects 根目录不存在 → null 且不抛", async () => {
    const titles = new QwenTitles({ root: join(tmpdir(), "webmux-qwen-nope-xyz") });
    await expect(titles.resolve("/w", tty)).resolves.toBe(null);
  });

  it("tty 对不上 → null（不拿别人的话题兜底）", async () => {
    const titles = new QwenTitles({ root });
    await expect(titles.resolve("/w", "/dev/pts/99999")).resolves.toBe(null);
  });

  it("首条消息还没落盘 → 本轮 null，补写之后下轮能拿到（null 不缓存）", async () => {
    const solo = await mkdtemp(join(tmpdir(), "webmux-qwen-late-"));
    const chats = join(solo, "-late", "chats");
    await mkdir(chats, { recursive: true });
    await writeFile(join(chats, "s3.runtime.json"), runtime(process.pid, "s3"));
    await writeFile(join(chats, "s3.jsonl"), "");

    const titles = new QwenTitles({ root: solo });
    await expect(titles.resolve("/w", tty)).resolves.toBe(null);

    await writeFile(join(chats, "s3.jsonl"), userLine("晚一点才说的话"));
    await expect(titles.resolve("/w", tty)).resolves.toBe("晚一点才说的话");

    await rm(solo, { recursive: true, force: true });
  });
});

describe("Surfaces 跟随 qwen 话题", () => {
  const cfg = loadConfig({
    ...process.env,
    WEBMUX_SOCKET: "webmux_test_qwen",
    WEBMUX_PREFIX: "wm_",
    WEBMUX_STATE: "/tmp/webmux-test-qwen-state.json",
  });

  const session = (over: Partial<TmuxSession> = {}): TmuxSession => ({
    name: "wm_aaaaaaaa",
    id: "aaaaaaaa",
    title: "",
    cwd: "/home/x/autorequirement",
    paneTty: "/dev/pts/3",
    paneTitle: "Qwen - autorequirement",
    createdAt: 1,
    activityAt: 2,
    attached: 0,
    command: "node",
    dead: false,
    ...over,
  });

  const surfacesWith = (s: TmuxSession, resolve: () => Promise<string | null>) =>
    new Surfaces({ listSessions: async () => [s] } as unknown as Tmux, cfg, {
      resolve,
    } as unknown as QwenTitles);

  it("qwen 的默认标题被换成话题", async () => {
    const list = await surfacesWith(session(), async () => "把登录改成两因子").list();
    expect(list[0].title).toBe("把登录改成两因子");
  });

  it("手动命名过的不跟随（INV-7）", async () => {
    const list = await surfacesWith(session({ title: "我起的名字" }), async () => "话题").list();
    expect(list[0].title).toBe("我起的名字");
    expect(list[0].pinned).toBe(true);
  });

  it("resolve 抛错时退回原自动标题，不拖垮整个列表", async () => {
    const list = await surfacesWith(session(), async () => {
      throw new Error("读盘炸了");
    }).list();
    expect(list[0].title).toBe("Qwen - autorequirement");
  });
});
