import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.ts";
import { Tmux, TmuxError, sanitizeTitle } from "../src/server/tmux.ts";

const cfg = loadConfig({
  ...process.env,
  WEBMUX_SOCKET: "webmux_test_tmux",
  WEBMUX_PREFIX: "wm_",
  WEBMUX_STATE: "/tmp/webmux-test-tmux-state.json",
});
const tmux = new Tmux(cfg);
const name = (id: string) => cfg.prefix + id;

async function waitFor<T>(fn: () => Promise<T | null>, ms = 6000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("等超时了");
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeAll(async () => {
  await tmux.killServer();
});
afterAll(async () => {
  await tmux.killServer();
});

describe("Tmux", () => {
  it("没有 server 时列表是空的，而不是抛错", async () => {
    await tmux.killServer();
    await expect(tmux.listSessions()).resolves.toEqual([]);
  });

  it("建会话后能查到，字段都解析得出来", async () => {
    await tmux.newSession(name("aaaaaaaa"), "/tmp");
    const list = await tmux.listSessions();
    const s = list.find((x) => x.id === "aaaaaaaa")!;
    expect(s).toBeTruthy();
    expect(s.name).toBe("wm_aaaaaaaa");
    expect(s.title).toBe(""); // 没手动命名过
    expect(s.cwd).toContain("tmp");
    expect(s.createdAt).toBeGreaterThan(0);
    expect(s.activityAt).toBeGreaterThan(0);
    expect(s.dead).toBe(false);
    expect(typeof s.command).toBe("string");
  });

  it("只认自己前缀下的会话", async () => {
    await tmux["exec"](["new-session", "-d", "-s", "someone_elses", "-c", "/tmp"]);
    const list = await tmux.listSessions();
    expect(list.some((s) => s.name === "someone_elses")).toBe(false);
    expect(list.every((s) => s.name.startsWith("wm_"))).toBe(true);
  });

  it("标题存在 tmux 里，含引号和换行也不会撑破解析", async () => {
    await tmux.setTitle(name("aaaaaaaa"), 'a "b" \'c\'\n第二行');
    const s = (await tmux.listSessions()).find((x) => x.id === "aaaaaaaa")!;
    expect(s.title).toBe(`a "b" 'c' 第二行`);
    expect((await tmux.listSessions()).length).toBeGreaterThan(0);
  });

  it("标题截断到 60 字", async () => {
    await tmux.setTitle(name("aaaaaaaa"), "长".repeat(120));
    const s = (await tmux.listSessions()).find((x) => x.id === "aaaaaaaa")!;
    expect(s.title.length).toBe(60);
    await tmux.setTitle(name("aaaaaaaa"), "");
  });

  it("capture 拿得到会话里的输出", async () => {
    await tmux["exec"](["send-keys", "-t", name("aaaaaaaa"), "echo 標記xyz", "Enter"]);
    const text = await waitFor(async () => {
      const out = await tmux.capturePane(name("aaaaaaaa"), 200);
      return out.includes("標記xyz") ? out : null;
    });
    expect(text).toContain("標記xyz");
  });

  it("会话里有输出之后 activityAt 会往前走——未读角标全靠这个", async () => {
    const before = (await tmux.listSessions()).find((s) => s.id === "aaaaaaaa")!.activityAt;
    await new Promise((r) => setTimeout(r, 1100)); // window_activity 是秒粒度
    await tmux["exec"](["send-keys", "-t", name("aaaaaaaa"), "echo tick", "Enter"]);
    const after = await waitFor(async () => {
      const s = (await tmux.listSessions()).find((x) => x.id === "aaaaaaaa")!;
      return s.activityAt > before ? s.activityAt : null;
    });
    expect(after).toBeGreaterThan(before);
  });

  it("capture 不存在的会话时降级成空串，不抛错", async () => {
    await expect(tmux.capturePane(name("nosuchxx"), 100)).resolves.toBe("");
  });

  it("hasSession 分得清有和没有", async () => {
    await expect(tmux.hasSession(name("aaaaaaaa"))).resolves.toBe(true);
    await expect(tmux.hasSession(name("nosuchxx"))).resolves.toBe(false);
  });

  it("kill 掉之后就查不到了", async () => {
    await tmux.newSession(name("bbbbbbbb"), "/tmp");
    await tmux.killSession(name("bbbbbbbb"));
    expect((await tmux.listSessions()).some((s) => s.id === "bbbbbbbb")).toBe(false);
  });

  it("kill 不存在的会话会抛 TmuxError，且带得上 stderr", async () => {
    let caught: unknown;
    try {
      await tmux.killSession(name("nosuchxx"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TmuxError);
    expect((caught as TmuxError).stderr).toMatch(/no such session|can't find session/i);
  });

  it("attachArgs 带上独立 socket 和精确匹配的 target", () => {
    expect(tmux.attachArgs("wm_zz")).toEqual([
      "-L",
      "webmux_test_tmux",
      "attach-session",
      "-t",
      "=wm_zz",
    ]);
  });
});

describe("sanitizeTitle", () => {
  it("控制字符和分隔符都被换成空格", () => {
    expect(sanitizeTitle("a\x00b\x1fc␟d")).toBe("a b c d");
  });
});
