import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync, existsSync } from "node:fs";
import WebSocket from "ws";
import { loadConfig } from "../src/server/config.ts";
import { createInstance, type Instance } from "../src/server/index.ts";
import { Store } from "../src/server/store.ts";
import { leaves, surfaceIds } from "../src/server/layout.ts";

const STATE = "/tmp/webmux-e2e-state.json";
const TOKEN = "e2e-token";

const cfg = loadConfig({
  ...process.env,
  WEBMUX_SOCKET: "webmux_e2e",
  WEBMUX_PREFIX: "wm_",
  WEBMUX_STATE: STATE,
  WEBMUX_PORT: "0",
  WEBMUX_TOKEN: TOKEN,
});

let inst: Instance;
let base: string;

const H = { "Content-Type": "application/json", "X-Webmux-Token": TOKEN };
const get = (p: string) => fetch(base + p, { headers: H });
const post = async (p: string, body: unknown = {}) => {
  const res = await fetch(base + p, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
};
const state = async () => (await get("/api/state")).json() as any;

const wsUrl = (p: string) => base.replace("http", "ws") + p + `&token=${TOKEN}`;

function openTerm(id: string, cols = 80, rows = 24) {
  const ws = new WebSocket(wsUrl(`/ws/term?id=${id}&cols=${cols}&rows=${rows}`));
  const chunks: string[] = [];
  ws.on("message", (d: Buffer, isBinary: boolean) => chunks.push(d.toString("utf8")));
  return { ws, chunks, text: () => chunks.join("") };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error("等超时了");
    await wait(120);
  }
}

beforeAll(async () => {
  rmSync(STATE, { force: true });
  inst = await createInstance(cfg);
  base = `http://127.0.0.1:${inst.port}`;
});

afterAll(async () => {
  await inst.close();
  await inst.tmux.killServer();
  rmSync(STATE, { force: true });
});

describe("端到端", () => {
  it("首次启动给一个空工作区", async () => {
    const s = await state();
    expect(s.workspaces).toHaveLength(1);
    expect(s.workspaces[0].name).toBe("默认");
    expect(surfaceIds(s.workspaces[0].layout)).toEqual([]);
    expect(s.surfaces).toEqual([]);
  });

  it("建终端后既能查到会话，也进了布局树", async () => {
    const { body } = await post("/api/surface/create", {});
    expect(body.surface.id).toMatch(/^[0-9a-f]{8}$/);
    const s = await state();
    expect(s.surfaces.some((x: any) => x.id === body.surface.id)).toBe(true);
    expect(surfaceIds(s.workspaces[0].layout)).toContain(body.surface.id);
  });

  it("WebSocket 上敲命令能看到回显", async () => {
    const { body } = await post("/api/surface/create", {});
    const t = openTerm(body.surface.id);
    await new Promise((r) => t.ws.once("open", r));
    await wait(400);
    t.ws.send(Buffer.from("echo hello-e2e\r"));
    await until(() => t.text().includes("hello-e2e"));
    t.ws.close();
  });

  it("断开重连能回放历史——这是「关了页面回来还在」的关键", async () => {
    const { body } = await post("/api/surface/create", {});
    const a = openTerm(body.surface.id);
    await new Promise((r) => a.ws.once("open", r));
    await wait(400);
    a.ws.send(Buffer.from("echo replay-marker\r"));
    await until(() => a.text().includes("replay-marker"));
    a.ws.close();
    await wait(300);

    const b = openTerm(body.surface.id);
    await new Promise((r) => b.ws.once("open", r));
    await until(() => b.text().includes("replay-marker"));
    // 回灌的历史必须是 CRLF，否则 xterm 里阶梯状错位
    expect(b.text()).not.toMatch(/[^\r]\n/);
    b.ws.close();
  });

  it("连不存在的会话会被干脆拒掉，而不是挂着", async () => {
    const t = openTerm("deadbeef");
    const code = await new Promise<number>((r) => t.ws.once("close", (c) => r(c)));
    expect(code).toBe(4404);
  });

  it("并发快建几个都能建出来，id 不撞", async () => {
    const before = (await state()).surfaces.length;
    const made = await Promise.all([
      post("/api/surface/create", {}),
      post("/api/surface/create", {}),
      post("/api/surface/create", {}),
      post("/api/surface/create", {}),
    ]);
    const ids = made.map((m) => m.body.surface.id);
    expect(new Set(ids).size).toBe(4);
    expect((await state()).surfaces.length).toBe(before + 4);
  });

  it("标题默认跟随终端里在跑什么，重命名之后才固定下来", async () => {
    const { body } = await post("/api/surface/create", { cwd: "/tmp" });
    const id = body.surface.id;
    expect(body.surface.pinned).toBe(false);
    expect(body.surface.title).toBe("tmp"); // 空闲 shell 显示目录名

    await post("/api/surface/rename", { id, title: "钉住的名字" });
    let s = (await state()).surfaces.find((x: any) => x.id === id);
    expect(s.pinned).toBe(true);
    expect(s.title).toBe("钉住的名字");

    await post("/api/surface/rename", { id, title: "" }); // 取消手动命名
    s = (await state()).surfaces.find((x: any) => x.id === id);
    expect(s.pinned).toBe(false);
    expect(s.title).toBe("tmp");
  });

  it("粘贴图片：存到会话当前目录，返回可直接喂给 agent 的路径", async () => {
    const { body } = await post("/api/surface/create", { cwd: "/tmp" });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");
    const res = await post("/api/paste-image", {
      surfaceId: body.surface.id,
      mime: "image/png",
      data: png,
    });
    expect(res.status).toBe(200);
    expect(res.body.path).toMatch(/\/tmp\/pasted-\d{8}-\d{6}-\d{3}\.png$/);
    expect(existsSync(res.body.path)).toBe(true);
    rmSync(res.body.path, { force: true });
  });

  it("粘贴图片：不认识的类型拒掉", async () => {
    const { body } = await post("/api/surface/create", {});
    const res = await post("/api/paste-image", {
      surfaceId: body.surface.id,
      mime: "application/x-sh",
      data: Buffer.from("rm -rf /").toString("base64"),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/不支持/);
  });

  it("把终端挪到另一个格子（拖拽落到别的分屏）", async () => {
    const { body: made } = await post("/api/surface/create", {});
    const id = made.surface.id;
    const { body: sp } = await post("/api/layout/split", { dir: "row" });
    const w = sp.workspaces.find((x: any) => x.id === sp.activeWorkspace);
    const target = leaves(w.layout).find((l: any) => l.tabs.includes(sp.surface.id))!;

    const { body } = await post("/api/layout/move", {
      surfaceId: id,
      toWorkspaceId: w.id,
      toLeafId: target.id,
    });
    const after = body.workspaces.find((x: any) => x.id === w.id);
    const leaf = leaves(after.layout).find((l: any) => l.id === target.id)!;
    expect(leaf.tabs).toContain(id);
    expect(leaves(after.layout).filter((l: any) => l.tabs.includes(id))).toHaveLength(1);
  });

  it("把终端挪到另一个工作区，源工作区里就没有它了", async () => {
    const { body: made } = await post("/api/surface/create", {});
    const id = made.surface.id;
    const from = made.activeWorkspace;
    const { body: ws } = await post("/api/workspace/create", { name: "别处" });
    const target = ws.workspaces.find((x: any) => x.name === "别处");

    const { body } = await post("/api/layout/move", {
      surfaceId: id,
      toWorkspaceId: target.id,
      toLeafId: leaves(target.layout)[0].id,
    });
    const src = body.workspaces.find((x: any) => x.id === from);
    const dst = body.workspaces.find((x: any) => x.id === target.id);
    expect(surfaceIds(src.layout)).not.toContain(id);
    expect(surfaceIds(dst.layout)).toContain(id);
    await post("/api/workspace/activate", { id: from });
  });

  it("从 tmux 那边手工建的会话是「游离」的，adopt 之后才进布局", async () => {
    const name = inst.tmux.sessionName("cafe1234");
    await inst.tmux.newSession(name, "/tmp");
    const s = await state();
    expect(s.surfaces.some((x: any) => x.id === "cafe1234")).toBe(true);
    const placed = s.workspaces.flatMap((w: any) => surfaceIds(w.layout));
    expect(placed).not.toContain("cafe1234");

    const { body } = await post("/api/layout/adopt", { surfaceId: "cafe1234" });
    const nowPlaced = body.workspaces.flatMap((w: any) => surfaceIds(w.layout));
    expect(nowPlaced).toContain("cafe1234");
  });

  it("adopt 一个不存在的会话会被拒", async () => {
    const res = await post("/api/layout/adopt", { surfaceId: "99999999" });
    expect(res.status).toBe(400);
  });

  it("分屏会新开一个会话，布局变成 split", async () => {
    const before = (await state()).surfaces.length;
    const { body } = await post("/api/layout/split", { dir: "col" });
    const w = body.workspaces.find((x: any) => x.id === body.activeWorkspace);
    expect(w.layout.kind).toBe("split");
    expect((await state()).surfaces.length).toBe(before + 1);
    expect(surfaceIds(w.layout)).toContain(body.surface.id);
    expect(w.focusedLeaf).toBe(
      leaves(w.layout).find((l: any) => l.tabs.includes(body.surface.id))!.id,
    );
  });

  it("改名之后 tmux 那边也跟着变了", async () => {
    const { body } = await post("/api/surface/create", {});
    await post("/api/surface/rename", { id: body.surface.id, title: "tmux 里也要有" });
    const raw = (await inst.tmux.listSessions()).find((s) => s.id === body.surface.id)!;
    expect(raw.title).toBe("tmux 里也要有");
  });

  it("从 tmux 那边手工 kill 掉，网页状态会自动对账摘掉它", async () => {
    const { body } = await post("/api/surface/create", {});
    const id = body.surface.id;
    await inst.tmux.killSession(inst.tmux.sessionName(id));
    const s = await state(); // 每次读状态都对账
    expect(s.surfaces.some((x: any) => x.id === id)).toBe(false);
    expect(s.workspaces.flatMap((w: any) => surfaceIds(w.layout))).not.toContain(id);
  });

  it("关格子会连里面的会话一起关掉，不留孤儿", async () => {
    const { body: sp } = await post("/api/layout/split", { dir: "row" });
    const w = sp.workspaces.find((x: any) => x.id === sp.activeWorkspace);
    const leaf = leaves(w.layout).find((l: any) => l.tabs.includes(sp.surface.id))!;

    const { body } = await post("/api/layout/close-leaf", { leafId: leaf.id });
    expect(body.surfaces.some((x: any) => x.id === sp.surface.id)).toBe(false);
    const after = body.workspaces.find((x: any) => x.id === w.id);
    expect(leaves(after.layout).some((l: any) => l.id === leaf.id)).toBe(false);
  });

  it("新建工作区会连第一个终端一起建出来", async () => {
    const { body } = await post("/api/workspace/create", { name: "带终端的" });
    const ws = body.workspaces.find((x: any) => x.name === "带终端的");
    expect(ws).toBeTruthy();
    expect(surfaceIds(ws.layout)).toEqual([body.surface.id]);
    expect(body.activeWorkspace).toBe(ws.id);
  });

  it("标签全关掉之后，那个工作区自动关闭", async () => {
    const { body: ws } = await post("/api/workspace/create", { name: "要被收掉的" });
    const target = ws.workspaces.find((x: any) => x.name === "要被收掉的");
    const { body } = await post("/api/surface/close", { id: ws.surface.id });
    expect(body.workspaces.some((x: any) => x.id === target.id)).toBe(false);
  });

  it("最后一个工作区不会被清掉——空着也得留一个，不然人无处可去", async () => {
    // 先把现有会话全关掉
    for (const s of (await state()).surfaces) {
      await post("/api/surface/close", { id: s.id });
    }
    const s = await state();
    expect(s.workspaces.length).toBe(1);
    expect(surfaceIds(s.workspaces[0].layout)).toEqual([]);
  });

  it("布局落盘了：重开一个 Store 也能读回来", async () => {
    const { body } = await post("/api/surface/create", {});
    await inst.store.flush();
    const reopened = new Store(STATE);
    const ws = reopened.get().workspaces;
    expect(ws.flatMap((w) => surfaceIds(w.layout))).toContain(body.surface.id);
    expect(reopened.get().version).toBe(1);
  });
});

describe("鉴权", () => {
  const raw = (p: string, init: RequestInit = {}) => fetch(base + p, init);

  it("不带令牌一律 401", async () => {
    expect((await raw("/api/state")).status).toBe(401);
  });

  it("header 带令牌能过", async () => {
    expect((await raw("/api/state", { headers: { "X-Webmux-Token": TOKEN } })).status).toBe(200);
  });

  it("query 带令牌能过，并且会种下 cookie", async () => {
    const res = await raw(`/api/state?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("webmux_token=");
    expect(res.headers.get("set-cookie")).toContain("SameSite=Lax");
  });

  it("有了 cookie，静态资源不带 token 也能拿到——白屏就是栽在这里", async () => {
    const res = await raw("/index.html", { headers: { cookie: `webmux_token=${TOKEN}` } });
    expect(res.status).toBe(200);
    // 静态压根不该被令牌拦：iframe 里 SameSite=Lax 的 cookie 不随子资源发送
    expect((await raw("/index.html")).status).toBe(200);
  });

  it("cookie 值不对照样拒", async () => {
    const res = await raw("/api/state", { headers: { cookie: "webmux_token=wrong" } });
    expect(res.status).toBe(401);
  });

  it("监听非回环地址却没设令牌时，直接拒绝启动", () => {
    expect(() =>
      loadConfig({ ...process.env, WEBMUX_HOST: "0.0.0.0", WEBMUX_TOKEN: "" }),
    ).toThrow(/拒绝启动/);
  });
});
