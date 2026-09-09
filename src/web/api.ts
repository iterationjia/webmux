/** REST 薄封装 + 事件流订阅。类型在这里重新声明一份，不和服务端共享文件。 */

export type Direction = "row" | "col";

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

export interface LeafNode {
  kind: "leaf";
  id: string;
  tabs: string[];
  active: string | null;
}
export interface SplitNode {
  kind: "split";
  id: string;
  dir: Direction;
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}
export type LayoutNode = LeafNode | SplitNode;

export interface Workspace {
  id: string;
  name: string;
  layout: LayoutNode;
  focusedLeaf: string;
}

export interface State {
  surfaces: Surface[];
  version: number;
  workspaces: Workspace[];
  activeWorkspace: string;
}

/** 地址栏里那份 token —— 也是 WebSocket 唯一能用的方式。 */
export const TOKEN = new URLSearchParams(location.search).get("token") ?? "";

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (TOKEN) h["X-Webmux-Token"] = TOKEN;
  return h;
}

async function post<T = State>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error || `${res.status}`);
  return data as T;
}

export function wsUrl(path: string, params: Record<string, string> = {}): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${proto}//${location.host}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (TOKEN) url.searchParams.set("token", TOKEN);
  return url.toString();
}

export const api = {
  async state(): Promise<State> {
    const res = await fetch("/api/state", { headers: headers() });
    if (!res.ok) throw new Error(`加载状态失败 ${res.status}`);
    return res.json();
  },
  createSurface: (body: {
    title?: string;
    cwd?: string;
    command?: string;
    workspaceId?: string;
    leafId?: string;
  } = {}) => post<State & { surface: Surface }>("/api/surface/create", body),
  rename: (id: string, title: string) => post("/api/surface/rename", { id, title }),
  close: (id: string) => post("/api/surface/close", { id }),
  split: (body: { workspaceId?: string; leafId?: string; dir: Direction; cwd?: string }) =>
    post<State & { surface: Surface }>("/api/layout/split", body),
  move: (surfaceId: string, toWorkspaceId: string, toLeafId: string) =>
    post("/api/layout/move", { surfaceId, toWorkspaceId, toLeafId }),
  adopt: (surfaceId: string, workspaceId?: string, leafId?: string) =>
    post("/api/layout/adopt", { surfaceId, workspaceId, leafId }),
  ratio: (splitId: string, ratio: number, workspaceId?: string) =>
    post<{ ok: true }>("/api/layout/ratio", { splitId, ratio, workspaceId }),
  activateTab: (leafId: string, surfaceId: string, workspaceId?: string) =>
    post<{ ok: true }>("/api/layout/activate-tab", { leafId, surfaceId, workspaceId }),
  focus: (leafId: string, workspaceId?: string) =>
    post<{ ok: true }>("/api/layout/focus", { leafId, workspaceId }),
  closeLeaf: (leafId: string, workspaceId?: string) =>
    post("/api/layout/close-leaf", { leafId, workspaceId }),
  createWorkspace: (name?: string, cwd?: string) =>
    post<State & { surface: Surface }>("/api/workspace/create", { name, cwd }),
  activateWorkspace: (id: string) =>
    post<{ ok: true }>("/api/workspace/activate", { id }),
  renameWorkspace: (id: string, name: string) =>
    post("/api/workspace/rename", { id, name }),
  pasteImage: (surfaceId: string, mime: string, data: string) =>
    post<{ path: string; bytes: number }>("/api/paste-image", { surfaceId, mime, data }),
};

/** 事件流断掉只是角标不动，不该整页刷新 —— 每 2 秒重连一次。 */
export function subscribeSurfaces(onSurfaces: (list: Surface[]) => void): () => void {
  let ws: WebSocket | null = null;
  let timer: number | undefined;
  let closed = false;

  const open = () => {
    if (closed) return;
    ws = new WebSocket(wsUrl("/ws/events"));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg?.type === "surfaces") onSurfaces(msg.surfaces as Surface[]);
      } catch {
        /* 忽略畸形帧 */
      }
    };
    ws.onclose = () => {
      if (!closed) timer = window.setTimeout(open, 2000);
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return () => {
    closed = true;
    window.clearTimeout(timer);
    ws?.close();
  };
}
