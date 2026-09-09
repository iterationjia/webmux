import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { readFileSync, statSync, createReadStream } from "node:fs";
import { join, normalize, extname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import pty from "node-pty";

import { loadConfig, isTlsEnabled, type Config } from "./config.ts";
import { Tmux } from "./tmux.ts";
import { Surfaces, SurfaceError, newLeafId, newWorkspaceId, type Surface } from "./surfaces.ts";
import { Store, emptyState, pruneEmpty, firstLeafId, layoutLeafIds } from "./store.ts";
import { Activity } from "./activity.ts";
import { saveImage, UploadError, MAX_IMAGE_BYTES } from "./upload.ts";
import {
  activateTab,
  addTab,
  leaves,
  makeLeaf,
  removeLeaf,
  removeTab,
  setRatio,
  splitLeaf,
  surfaceIds,
  type Direction,
  type LayoutNode,
  type Workspace,
} from "./layout.ts";

const WEB_ROOT = resolve(import.meta.dirname, "../../dist/web");
const MAX_BODY = MAX_IMAGE_BYTES * 2;
const COOKIE = "webmux_token";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

interface Snapshot {
  surfaces: Surface[];
  version: number;
  workspaces: Workspace[];
  activeWorkspace: string;
}

export interface Instance {
  port: number;
  url: string;
  close: () => Promise<void>;
  tmux: Tmux;
  surfaces: Surfaces;
  store: Store;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

function cookieValue(header: string | undefined, key: string): string {
  for (const part of (header ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === key) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function createInstance(cfg: Config): Promise<Instance> {
  const tmux = new Tmux(cfg);
  const surfaces = new Surfaces(tmux, cfg);
  const store = new Store(cfg.stateFile);
  const activity = new Activity(surfaces);

  /** 令牌三来源，任一匹配即通过。WS 握手加不了自定义 header，所以 query 必须支持。 */
  const authorized = (req: IncomingMessage, url: URL): boolean => {
    if (!cfg.token) return true;
    const header = req.headers["x-webmux-token"];
    if (typeof header === "string" && header === cfg.token) return true;
    if (url.searchParams.get("token") === cfg.token) return true;
    if (cookieValue(req.headers.cookie, COOKIE) === cfg.token) return true;
    return false;
  };

  const snapshot = async (): Promise<Snapshot> => {
    const list = await surfaces.list();
    const state = store.sync(list.map((s) => s.id));
    return {
      surfaces: list,
      version: state.version,
      workspaces: state.workspaces,
      activeWorkspace: state.activeWorkspace,
    };
  };

  const mutate = (fn: (ws: Workspace) => Workspace, wsId?: string): void => {
    const state = store.get();
    const target = store.wsById(wsId);
    store.set({
      ...state,
      workspaces: state.workspaces.map((w) => (w.id === target.id ? fn(w) : w)),
    });
  };

  // ——————————————————————— REST ———————————————————————

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const path = url.pathname;

    if (path === "/api/state") {
      if (req.method !== "GET") return json(res, 404, { error: "未知路由" });
      return json(res, 200, await snapshot());
    }

    if (req.method !== "POST") return json(res, 404, { error: "未知路由" });

    let body: any = {};
    const raw = await readBody(req);
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: "请求体不是合法 JSON" });
      }
    }

    switch (path) {
      case "/api/surface/create": {
        const surface = await surfaces.create({
          title: body.title,
          cwd: body.cwd,
          command: body.command,
        });
        const ws = store.wsById(body.workspaceId);
        const leafId = body.leafId || ws.focusedLeaf;
        mutate((w) => ({ ...w, layout: addTab(w.layout, leafId, surface.id) }), ws.id);
        activity.kick();
        return json(res, 200, { surface, ...(await snapshot()) });
      }

      case "/api/surface/rename": {
        await surfaces.rename(String(body.id), String(body.title ?? ""));
        activity.kick();
        return json(res, 200, await snapshot());
      }

      case "/api/surface/close": {
        await surfaces.close(String(body.id));
        activity.kick();
        return json(res, 200, await snapshot());
      }

      case "/api/layout/split": {
        const ws = store.wsById(body.workspaceId);
        const leafId = body.leafId || ws.focusedLeaf;
        // 分屏 = 新开一个会话放进新格子（cmux 同语义）
        const surface = await surfaces.create({ cwd: body.cwd });
        const dir: Direction = body.dir === "col" ? "col" : "row";
        const leaf = newLeafId();
        mutate(
          (w) => ({
            ...w,
            layout: splitLeaf(w.layout, leafId, dir, leaf, surface.id),
            focusedLeaf: leaf,
          }),
          ws.id,
        );
        activity.kick();
        return json(res, 200, { surface, ...(await snapshot()) });
      }

      case "/api/layout/move": {
        const surfaceId = String(body.surfaceId);
        const toWs = store.wsById(body.toWorkspaceId);
        // 顺序不能反：同格子内拖动时反过来会先挂上再被自己摘掉
        const state = store.get();
        const stripped = state.workspaces.map((w) => ({
          ...w,
          layout: removeTab(w.layout, surfaceId),
        }));
        store.set({ ...state, workspaces: stripped });
        // 目标格子可能刚因摘空被收掉，则退到 leaves[0]
        const fresh = store.wsById(toWs.id);
        const ids = layoutLeafIds(fresh.layout);
        const leafId = ids.includes(String(body.toLeafId))
          ? String(body.toLeafId)
          : leaves(fresh.layout)[0].id;
        mutate(
          (w) => ({ ...w, layout: addTab(w.layout, leafId, surfaceId), focusedLeaf: leafId }),
          fresh.id,
        );
        activity.kick();
        return json(res, 200, await snapshot());
      }

      case "/api/layout/adopt": {
        const surfaceId = String(body.surfaceId);
        if (!(await surfaces.get(surfaceId))) {
          return json(res, 400, { error: "会话不存在" });
        }
        const ws = store.wsById(body.workspaceId);
        const leafId = body.leafId || ws.focusedLeaf;
        mutate((w) => ({ ...w, layout: addTab(w.layout, leafId, surfaceId) }), ws.id);
        activity.kick();
        return json(res, 200, await snapshot());
      }

      case "/api/layout/ratio": {
        mutate(
          (w) => ({ ...w, layout: setRatio(w.layout, String(body.splitId), Number(body.ratio)) }),
          body.workspaceId,
        );
        return json(res, 200, { ok: true });
      }

      case "/api/layout/activate-tab": {
        mutate(
          (w) => ({
            ...w,
            layout: activateTab(w.layout, String(body.leafId), String(body.surfaceId)),
            focusedLeaf: String(body.leafId),
          }),
          body.workspaceId,
        );
        return json(res, 200, { ok: true });
      }

      case "/api/layout/focus": {
        mutate((w) => ({ ...w, focusedLeaf: String(body.leafId) }), body.workspaceId);
        return json(res, 200, { ok: true });
      }

      case "/api/layout/close-leaf": {
        const ws = store.wsById(body.workspaceId);
        const leafId = String(body.leafId || ws.focusedLeaf);
        const leaf = leaves(ws.layout).find((l) => l.id === leafId);
        // 连里面的会话一起关 —— 留着会话却没有入口，比直接关掉更糟
        for (const id of leaf?.tabs ?? []) {
          try {
            await surfaces.close(id);
          } catch {
            /* 已经没了 */
          }
        }
        mutate((w) => {
          const layout = removeLeaf(w.layout, leafId);
          const ids = layoutLeafIds(layout);
          return {
            ...w,
            layout,
            focusedLeaf: ids.includes(w.focusedLeaf) ? w.focusedLeaf : firstLeafId(layout),
          };
        }, ws.id);
        activity.kick();
        return json(res, 200, await snapshot());
      }

      case "/api/workspace/create": {
        // 空工作区会被 pruneEmpty 收掉，所以第一个终端必须同一个请求里建出来（INV-5）
        const surface = await surfaces.create({ cwd: body.cwd });
        const leaf = makeLeaf(newLeafId(), [surface.id]);
        const state = store.get();
        const ws: Workspace = {
          id: newWorkspaceId(),
          name: String(body.name || `工作区 ${state.workspaces.length + 1}`),
          layout: leaf,
          focusedLeaf: leaf.id,
        };
        store.set({
          ...state,
          workspaces: [...state.workspaces, ws],
          activeWorkspace: ws.id,
        });
        activity.kick();
        return json(res, 200, { surface, ...(await snapshot()) });
      }

      case "/api/workspace/activate": {
        const state = store.get();
        if (state.workspaces.some((w) => w.id === body.id)) {
          store.set({ ...state, activeWorkspace: String(body.id) });
        }
        return json(res, 200, { ok: true });
      }

      case "/api/workspace/rename": {
        const name = String(body.name ?? "").trim();
        if (name) {
          const state = store.get();
          store.set({
            ...state,
            workspaces: state.workspaces.map((w) =>
              w.id === body.id ? { ...w, name } : w,
            ),
          });
        }
        return json(res, 200, await snapshot());
      }

      case "/api/paste-image": {
        const id = String(body.surfaceId);
        const surface = await surfaces.get(id);
        if (!surface) return json(res, 400, { error: "会话不存在" });
        // 存到会话此刻所在的目录（跟着 cd 走），不是建出来时那个
        const dir = (await tmux.currentPath(tmux.sessionName(id))) || surface.cwd;
        const saved = saveImage(dir, String(body.mime), String(body.data ?? ""));
        return json(res, 200, saved);
      }

      default:
        return json(res, 404, { error: "未知路由" });
    }
  }

  // ——————————————————————— 静态 ———————————————————————

  function serveStatic(url: URL, res: ServerResponse): void {
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const target = normalize(join(WEB_ROOT, rel));
    if (!target.startsWith(WEB_ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    let st;
    try {
      st = statSync(target);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 —— 前端还没构建？跑一次 npm run build:web");
      return;
    }
    if (st.isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[extname(target)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(target).pipe(res);
  }

  // ——————————————————————— 服务器 ———————————————————————

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      // 带对 token 进来就种 cookie，之后静态资源和 WS 就都自动带上了
      if (cfg.token && url.searchParams.get("token") === cfg.token) {
        res.setHeader(
          "Set-Cookie",
          `${COOKIE}=${encodeURIComponent(cfg.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        );
      }
      if (url.pathname.startsWith("/api/")) {
        // 令牌只拦 /api/ 和 WS，不拦静态：iframe 嵌入时 SameSite=Lax 的 cookie
        // 不随子资源请求发送，拦静态会让嵌入页白屏（T-26）
        if (!authorized(req, url)) return json(res, 401, { error: "未授权" });
        return await handleApi(req, res, url);
      }
      serveStatic(url, res);
    } catch (err: any) {
      if (err instanceof SurfaceError || err instanceof UploadError) {
        return json(res, 400, { error: err.message });
      }
      json(res, 500, { error: `${err?.name ?? "Error"}: ${err?.message ?? err}` });
    }
  };

  const server = isTlsEnabled(cfg)
    ? createHttps(
        { cert: readFileSync(cfg.tlsCert), key: readFileSync(cfg.tlsKey) },
        (req, res) => void handler(req, res),
      )
    : createHttp((req, res) => void handler(req, res));

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!authorized(req, url)) return socket.destroy();
    if (url.pathname !== "/ws/term" && url.pathname !== "/ws/events") {
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === "/ws/events") attachEvents(ws);
      else void attachTerm(ws, url);
    });
  });

  function attachEvents(ws: WebSocket): void {
    const off = activity.subscribe((list) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "surfaces", surfaces: list }));
      }
    });
    ws.on("close", off);
    ws.on("error", off);
  }

  async function attachTerm(ws: WebSocket, url: URL): Promise<void> {
    const id = url.searchParams.get("id") ?? "";
    const cols = Math.max(20, Number(url.searchParams.get("cols")) || 80);
    const rows = Math.max(5, Number(url.searchParams.get("rows")) || 24);
    const name = tmux.sessionName(id);

    // 存在性检查和拉滚动历史并行 —— 串起来就是双倍延迟，
    // 切到一个还没连过的终端时直接体现为「半天才出来」
    const [exists, history] = await Promise.all([
      tmux.hasSession(name),
      tmux.capturePane(name, cfg.scrollback),
    ]);
    if (!exists) {
      ws.close(4404, "会话不存在或已关闭");
      return;
    }

    // attach 只重绘当前屏、不带历史（T-10）；capture 出来的行尾没有 \r，
    // 直接喂给 xterm 会阶梯状错位（T-11）
    if (history) ws.send(Buffer.from(history.replace(/\r?\n/g, "\r\n") + "\r\n"));

    const term = pty.spawn(cfg.tmuxBin, tmux.attachArgs(name), {
      name: "xterm-256color",
      cols,
      rows,
      cwd: cfg.defaultCwd,
      env: attachEnv(),
    });

    // attach 的首屏由 tmux 画，赶上会话刚建出来或尺寸正在变，可能画成空的
    const redraw = setTimeout(() => void tmux.refreshClients(name), 300);

    term.onData((d) => {
      if (ws.readyState === ws.OPEN) ws.send(Buffer.from(d, "utf8"));
    });
    term.onExit(({ exitCode }) => {
      // attach 退出 ≠ 会话结束：可能是被 kill，也可能是用户敲了 detach
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "exit", exitCode }));
        ws.close(1000);
      }
    });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        term.write(data.toString("utf8"));
        return;
      }
      // 文本帧才是控制消息 —— 不靠「能不能解析成 JSON」区分，
      // 否则在 shell 里敲一段 JSON 会被当成控制消息吃掉
      try {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg?.type === "resize") {
          term.resize(
            Math.min(500, Math.max(20, Number(msg.cols) || cols)),
            Math.min(200, Math.max(5, Number(msg.rows) || rows)),
          );
        }
      } catch {
        /* 畸形帧一律忽略，不能把终端搞断 */
      }
    });

    const cleanup = () => {
      clearTimeout(redraw);
      try {
        term.kill();
      } catch {
        /* 已经没了 */
      }
    };
    ws.on("close", cleanup); // 不动会话 —— 那正是多标签的意义
    ws.on("error", cleanup);
  }

  /** webmux 自己可能就跑在某个 tmux 里，继承下去 tmux 会判定成嵌套并拒绝 attach。 */
  function attachEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    env.TERM = "xterm-256color";
    return env;
  }

  return new Promise<Instance>((ok) => {
    server.listen(cfg.port, cfg.host, async () => {
      await tmux.applyServerDefaults(); // 升级后那些早就跑着的会话也要拿到新选项
      await surfaces.migrateLegacyTitles();
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : cfg.port;
      ok({
        port,
        url: `${isTlsEnabled(cfg) ? "https" : "http"}://${cfg.host}:${port}`,
        tmux,
        surfaces,
        store,
        close: async () => {
          activity.stop();
          for (const client of wss.clients) client.terminate();
          wss.close();
          await new Promise<void>((done) => server.close(() => done()));
          await store.flush();
        },
      });
    });
  });
}

const isEntry =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.dirname, "index.ts");

if (isEntry) {
  const cfg = loadConfig();
  createInstance(cfg).then((inst) => {
    console.log(`webmux 跑起来了：${inst.url}`);
    console.log(`  tmux=${cfg.tmuxBin} socket=${cfg.socket} 前缀=${cfg.prefix}`);
    if (cfg.token) console.log(`  首次打开加上 ?token=${cfg.token}`);
  });
}
