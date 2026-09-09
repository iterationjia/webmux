import "@xterm/xterm/css/xterm.css";
import "./style.css";
import {
  api,
  subscribeSurfaces,
  type LayoutNode,
  type LeafNode,
  type State,
  type Surface,
  type Workspace,
} from "./api.ts";
import { TermPool, type TermView } from "./term.ts";
import { step, type NavWorkspace } from "./navigation.ts";

const IS_MAC = /mac/i.test(navigator.platform || navigator.userAgent);
const DRAG_TYPE = "text/webmux-surface";

const pool = new TermPool();
let state: State | null = null;
/** 页面刚打开时把所有会话都记成「已看过」，否则一进来全是未读角标，那是噪音。 */
const lastSeen = new Map<string, number>();
let seeded = false;
let signature = "";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;
const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// ——————————————————————— 取数 ———————————————————————

const activeWs = (): Workspace | null =>
  state?.workspaces.find((w) => w.id === state!.activeWorkspace) ??
  state?.workspaces[0] ??
  null;

function leavesOf(node: LayoutNode): LeafNode[] {
  return node.kind === "leaf" ? [node] : [...leavesOf(node.a), ...leavesOf(node.b)];
}
const wsLeaves = (w: Workspace) => leavesOf(w.layout);

const focusedLeaf = (): LeafNode | null => {
  const w = activeWs();
  if (!w) return null;
  const ls = wsLeaves(w);
  return ls.find((l) => l.id === w.focusedLeaf) ?? ls[0] ?? null;
};
const currentSurfaceId = (): string | null => focusedLeaf()?.active ?? null;
const surfaceById = (id: string): Surface | undefined =>
  state?.surfaces.find((s) => s.id === id);

/** 布局里出现过的 surface —— 没出现的就是「不在任何工作区」的游离会话。 */
function placedIds(): Set<string> {
  const out = new Set<string>();
  for (const w of state?.workspaces ?? []) {
    for (const l of wsLeaves(w)) l.tabs.forEach((t) => out.add(t));
  }
  return out;
}

function visibleSurfaces(): Set<string> {
  const w = activeWs();
  if (!w) return new Set();
  return new Set(wsLeaves(w).map((l) => l.active).filter(Boolean) as string[]);
}

const navWorkspaces = (): NavWorkspace[] =>
  (state?.workspaces ?? []).map((w) => ({
    id: w.id,
    leaves: wsLeaves(w).map((l) => ({ id: l.id, tabs: l.tabs })),
  }));

/** 事件流每秒走一遍，弹层开着时不能把焦点抢回终端（T-23）。 */
const uiBlocking = (): boolean =>
  Boolean(document.querySelector(".ask, .menu, #help"));

// ——————————————————————— 提示与输入框 ———————————————————————

function toast(msg: string, err = false): void {
  const box = $("#toast");
  const n = el("div", err ? "t err" : "t", msg);
  box.appendChild(n);
  setTimeout(() => n.remove(), 3200);
}

/**
 * 绝不用原生 prompt/alert：它们会阻塞页面，更要命的是全屏时弹出会让浏览器
 * 退出全屏 —— 按一次重命名就掉出键盘独占，⌘T 跟着失效（T-24）。
 */
function ask(title: string, value = ""): Promise<string | null> {
  return new Promise((resolve) => {
    // 光做「不抢焦点」防不住：任何让 xterm textarea 重新拿到焦点的路径，
    // 都会让用户敲的字直接进 shell，而输入框里一个字都没有（T-23）
    pool.setInputEnabled(false);

    const mask = el("div", "mask");
    const box = el("div", "ask");
    box.appendChild(el("div", "title", title));
    const input = document.createElement("input");
    input.value = value;
    box.appendChild(input);
    mask.appendChild(box);
    document.body.appendChild(mask);

    const pull = (e: FocusEvent) => {
      if (!box.contains(e.target as Node)) input.focus();
    };
    document.addEventListener("focusin", pull, true);

    const done = (v: string | null) => {
      document.removeEventListener("focusin", pull, true);
      mask.remove();
      pool.setInputEnabled(true);
      resolve(v);
      render(false);
    };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // 在输入框里打 d 不该触发分屏
      if (e.key === "Enter") done(input.value);
      if (e.key === "Escape") done(null);
    });
    mask.addEventListener("mousedown", (e) => {
      if (e.target === mask) done(null);
    });
    setTimeout(() => input.focus(), 0);
  });
}

// ——————————————————————— 渲染 ———————————————————————

/**
 * 签名里刻意不含「当前显示哪个标签」—— 换标签只需要把另一个终端挂上来、改几个
 * class；重建一遍反而会让所有终端被搬家、闪一下。
 */
function structureSignature(w: Workspace): string {
  const walk = (n: LayoutNode): unknown =>
    n.kind === "leaf"
      ? { id: n.id, tabs: n.tabs }
      : { id: n.id, dir: n.dir, ratio: n.ratio, a: walk(n.a), b: walk(n.b) };
  return JSON.stringify({ ws: w.id, layout: walk(w.layout) });
}

function render(force: boolean): void {
  if (!state) return;
  const w = activeWs();
  if (!w) return;

  renderSidebar(); // 侧栏总是重建，它很小
  const sig = structureSignature(w);
  if (force || sig !== signature) {
    signature = sig;
    renderStage(w);
  } else {
    applyActiveTabs(w);
    refreshLabels();
  }
  const visible = visibleSurfaces();
  pool.reap(visible);
  const now = Date.now();
  for (const id of visible) lastSeen.set(id, now);
}

function isUnread(s: Surface, visible: Set<string>): boolean {
  return !visible.has(s.id) && s.activityAt > (lastSeen.get(s.id) ?? 0);
}

function renderSidebar(): void {
  const bar = $("#sidebar .scroll");
  bar.textContent = "";
  const w = activeWs();
  if (!state || !w) return;
  const visible = visibleSurfaces();

  bar.appendChild(section("工作区", () => void newWorkspace()));
  const wsList = el("div", "list");
  for (const ws of state.workspaces) {
    const row = el("div", "ws-item" + (ws.id === w.id ? " active" : ""));
    row.appendChild(el("div", "name", ws.name));
    row.onclick = () => switchWorkspace(ws.id);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      openMenu(e, [
        { label: "重命名…", run: () => void renameWorkspace(ws) },
      ]);
    };
    wsList.appendChild(row);
  }
  bar.appendChild(wsList);

  bar.appendChild(section("会话", () => void newSurface()));
  const placed = placedIds();
  const list = el("div", "list");
  for (const leaf of wsLeaves(w)) {
    for (const id of leaf.tabs) {
      const s = surfaceById(id);
      if (s) list.appendChild(surfaceRow(s, leaf, visible, false));
    }
  }
  bar.appendChild(list);

  const floating = state.surfaces.filter((s) => !placed.has(s.id));
  if (floating.length) {
    bar.appendChild(section("不在任何工作区"));
    const fl = el("div", "list");
    for (const s of floating) fl.appendChild(surfaceRow(s, null, visible, true));
    bar.appendChild(fl);
  }
}

function section(title: string, onAdd?: () => void): HTMLElement {
  const n = el("div", "section");
  n.appendChild(el("span", undefined, title));
  if (onAdd) {
    const add = el("span", "add", "+");
    add.onclick = onAdd;
    n.appendChild(add);
  }
  return n;
}

function surfaceRow(
  s: Surface,
  leaf: LeafNode | null,
  visible: Set<string>,
  floating: boolean,
): HTMLElement {
  const active = visible.has(s.id);
  const row = el(
    "div",
    "surf-item" +
      (active ? " active" : "") +
      (floating ? " floating" : "") +
      (s.dead ? " dead" : ""),
  );
  const dot = el("div", "dot");
  if (s.dead) dot.classList.add("dead");
  else if (active) dot.classList.add("on");
  else if (isUnread(s, visible)) dot.classList.add("unread");
  row.appendChild(dot);
  row.appendChild(el("div", "name", s.title));
  // 右边小字是「另一半信息」：标题已经是命令名时显示目录，反之显示命令
  const half = s.title === s.command ? baseName(s.cwd) : s.command;
  row.appendChild(el("div", "meta", half));
  row.title = `${s.title}\n${s.command} · ${s.cwd}`;

  row.onclick = () => {
    if (floating) void adopt(s.id);
    else if (leaf) selectTab(leaf.id, s.id);
  };
  row.oncontextmenu = (e) => {
    e.preventDefault();
    openMenu(e, [
      { label: "重命名…", run: () => void renameSurface(s) },
      { label: "关闭", danger: true, run: () => void closeSurface(s.id) },
    ]);
  };
  return row;
}

const baseName = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

function renderStage(w: Workspace): void {
  const stage = $("#stage");
  stage.textContent = "";
  stage.appendChild(buildNode(w.layout, w));
  applyActiveTabs(w);
}

function buildNode(node: LayoutNode, w: Workspace): HTMLElement {
  if (node.kind === "leaf") return buildPane(node, w);

  const box = el("div", `node ${node.dir}`);
  const a = buildNode(node.a, w);
  const b = buildNode(node.b, w);
  a.style.flex = `${node.ratio} 1 0`;
  b.style.flex = `${1 - node.ratio} 1 0`;

  const divider = el("div", "divider");
  divider.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const rect = box.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const raw =
        node.dir === "row"
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
      const r = Math.min(0.9, Math.max(0.1, raw));
      a.style.flex = `${r} 1 0`;
      b.style.flex = `${1 - r} 1 0`;
      node.ratio = r;
      pool.forEach((v) => v.fitAndResize());
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      void api.ratio(node.id, node.ratio, w.id); // 只在松手时落盘
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  box.append(a, divider, b);
  return box;
}

function buildPane(leaf: LeafNode, w: Workspace): HTMLElement {
  const pane = el("div", "pane");
  pane.dataset.leaf = leaf.id;
  if (leaf.id === w.focusedLeaf) pane.classList.add("focused");
  pane.addEventListener("mousedown", () => focusLeaf(leaf.id));

  const bar = el("div", "tabbar");
  for (const id of leaf.tabs) {
    const s = surfaceById(id);
    if (!s) continue;
    const tab = el("div", "tab" + (s.dead ? " dead" : ""));
    tab.dataset.surface = id;
    tab.draggable = true;
    tab.appendChild(el("span", "label", s.title));
    const x = el("span", "x", "✕");
    x.onclick = (e) => {
      e.stopPropagation();
      void closeSurface(id);
    };
    tab.appendChild(x);
    tab.onclick = () => selectTab(leaf.id, id);
    // 格子的 mousedown 把焦点交给 xterm textarea，Chrome 在 mousedown 后焦点
    // 一动就取消拖拽 —— 不 stopPropagation 的话标签根本拖不动（T-21）
    tab.addEventListener("mousedown", (e) => e.stopPropagation());
    tab.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData(DRAG_TYPE, id);
      e.dataTransfer?.setData("text/plain", id);
    });
    tab.oncontextmenu = (e) => {
      e.preventDefault();
      openTabMenu(e, id, leaf, w);
    };
    bar.appendChild(tab);
  }

  bar.appendChild(el("div", "spacer"));
  bar.appendChild(action("+", "新终端", () => void newSurface(leaf.id)));
  bar.appendChild(action("◫", "左右分屏", () => void split("row", leaf.id)));
  bar.appendChild(action("▤", "上下分屏", () => void split("col", leaf.id)));
  bar.appendChild(action("✕", "关闭格子", () => void closeLeaf(leaf.id)));
  pane.appendChild(bar);

  const body = el("div", "body");
  body.dataset.leaf = leaf.id;
  pane.appendChild(body);

  // 拖标签换格子
  pane.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes(DRAG_TYPE)) {
      e.preventDefault();
      pane.classList.add("drop-target");
    }
  });
  pane.addEventListener("dragleave", () => pane.classList.remove("drop-target"));
  pane.addEventListener("drop", (e) => {
    pane.classList.remove("drop-target");
    const id = e.dataTransfer?.getData(DRAG_TYPE);
    if (!id) return;
    e.preventDefault();
    void moveSurface(id, w.id, leaf.id);
  });

  return pane;
}

function action(glyph: string, title: string, run: () => void): HTMLElement {
  const n = el("div", "act", glyph);
  n.title = title;
  n.onclick = (e) => {
    e.stopPropagation();
    run();
  };
  return n;
}

/** 零重建路径：只改 class + 把该显示的终端挂上来。 */
function applyActiveTabs(w: Workspace): void {
  for (const leaf of wsLeaves(w)) {
    const pane = document.querySelector<HTMLElement>(`.pane[data-leaf="${leaf.id}"]`);
    if (!pane) continue;
    pane.classList.toggle("focused", leaf.id === w.focusedLeaf);
    pane.querySelectorAll<HTMLElement>(".tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.surface === leaf.active);
    });
    const body = pane.querySelector<HTMLElement>(".body")!;
    const want = leaf.active;
    const mounted = body.firstElementChild as HTMLElement | null;
    if (!want) {
      body.textContent = "";
      continue;
    }
    const view = pool.get(want);
    if (mounted !== view.el) {
      body.textContent = "";
      view.mount(body);
    }
    view.lastShownAt = Date.now();
  }
  requestAnimationFrame(() => pool.forEach((v) => v.fitAndResize()));
  if (!uiBlocking()) {
    const id = currentSurfaceId();
    if (id) pool.peek(id)?.focus();
  }
}

function refreshLabels(): void {
  document.querySelectorAll<HTMLElement>(".tab").forEach((tab) => {
    const s = surfaceById(tab.dataset.surface ?? "");
    if (!s) return;
    const label = tab.querySelector(".label")!;
    if (label.textContent !== s.title) label.textContent = s.title;
    tab.classList.toggle("dead", s.dead);
  });
}

// ——————————————————————— 右键菜单 ———————————————————————

interface MenuItem {
  label: string;
  danger?: boolean;
  run: () => void;
}

function openMenu(e: MouseEvent, items: (MenuItem | "sep" | { head: string })[]): void {
  closeMenu();
  const menu = el("div", "menu");
  for (const it of items) {
    if (it === "sep") {
      menu.appendChild(el("div", "sep"));
    } else if ("head" in it) {
      menu.appendChild(el("div", "head", it.head));
    } else {
      const n = el("div", "item" + (it.danger ? " danger" : ""), it.label);
      n.onclick = () => {
        closeMenu();
        it.run();
      };
      menu.appendChild(n);
    }
  }
  document.body.appendChild(menu);
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - w - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - h - 8)}px`;
  setTimeout(() => {
    window.addEventListener("mousedown", closeMenu, { once: true });
  }, 0);
}

function closeMenu(): void {
  document.querySelectorAll(".menu").forEach((m) => m.remove());
}

/**
 * 移动终端必须有一条确定性路径：菜单里直接列出所有去处。拖拽只是快捷方式 ——
 * 触控板上、格子很窄时并不好使。
 */
function openTabMenu(e: MouseEvent, id: string, leaf: LeafNode, w: Workspace): void {
  const items: (MenuItem | "sep" | { head: string })[] = [];
  const others = wsLeaves(w).filter((l) => l.id !== leaf.id);
  if (others.length) {
    items.push({ head: "移到格子" });
    others.forEach((l, i) => {
      const shown = l.active ? surfaceById(l.active)?.title ?? "空" : "空";
      items.push({
        label: `格子 ${i + 2}（${shown}）`,
        run: () => void moveSurface(id, w.id, l.id),
      });
    });
  }
  const otherWs = (state?.workspaces ?? []).filter((x) => x.id !== w.id);
  if (otherWs.length) {
    items.push({ head: "移到工作区" });
    for (const ws of otherWs) {
      items.push({
        label: ws.name,
        run: () => void moveSurface(id, ws.id, wsLeaves(ws)[0].id),
      });
    }
  }
  items.push("sep");
  items.push({ label: "新建左右分屏并移过去", run: () => void splitAndMove(id, "row", leaf.id) });
  items.push({ label: "新建上下分屏并移过去", run: () => void splitAndMove(id, "col", leaf.id) });
  items.push("sep");
  const s = surfaceById(id);
  if (s) items.push({ label: "重命名…", run: () => void renameSurface(s) });
  items.push({ label: "关闭", danger: true, run: () => void closeSurface(id) });
  openMenu(e, items);
}

// ——————————————————————— 动作 ———————————————————————

async function reload(next?: State): Promise<void> {
  state = next ?? (await api.state());
  if (!seeded) {
    const now = Date.now();
    for (const s of state.surfaces) lastSeen.set(s.id, Math.max(s.activityAt, now));
    seeded = true;
  }
  pool.prune(new Set(state.surfaces.map((s) => s.id)));
  render(true);
}

const guard = async (fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
  } catch (err: any) {
    toast(String(err?.message ?? err), true);
  }
};

const newSurface = (leafId?: string) =>
  guard(async () => reload(await api.createSurface({ leafId })));

const split = (dir: "row" | "col", leafId?: string) =>
  guard(async () => reload(await api.split({ dir, leafId })));

async function splitAndMove(id: string, dir: "row" | "col", leafId: string): Promise<void> {
  await guard(async () => {
    const res = await api.split({ dir, leafId });
    const w = res.workspaces.find((x) => x.id === res.activeWorkspace)!;
    const target = leavesOf(w.layout).find((l) => l.tabs.includes(res.surface.id))!;
    await api.move(id, w.id, target.id);
    // 新分屏是为了放这个标签，那个顺带建出来的会话就不留了
    await api.close(res.surface.id);
    await reload();
  });
}

const closeSurface = (id: string) => guard(async () => reload(await api.close(id)));
const closeLeaf = (leafId: string) => guard(async () => reload(await api.closeLeaf(leafId)));
const adopt = (id: string) => guard(async () => reload(await api.adopt(id)));
const moveSurface = (id: string, wsId: string, leafId: string) =>
  guard(async () => reload(await api.move(id, wsId, leafId)));

/** 切标签、切工作区、聚焦格子必须零延迟：先改本地并渲染，落盘请求 void 出去不等。 */
function selectTab(leafId: string, surfaceId: string): void {
  const w = activeWs();
  if (!w) return;
  const leaf = wsLeaves(w).find((l) => l.id === leafId);
  if (!leaf || !leaf.tabs.includes(surfaceId)) return;
  leaf.active = surfaceId;
  w.focusedLeaf = leafId;
  render(false);
  void api.activateTab(leafId, surfaceId, w.id);
}

function focusLeaf(leafId: string): void {
  const w = activeWs();
  if (!w || w.focusedLeaf === leafId) return;
  w.focusedLeaf = leafId;
  render(false);
  void api.focus(leafId, w.id);
}

function switchWorkspace(id: string): void {
  if (!state || state.activeWorkspace === id) return;
  state.activeWorkspace = id;
  render(true);
  void api.activateWorkspace(id);
}

async function newWorkspace(): Promise<void> {
  const name = await ask("新工作区名字", "");
  if (name === null) return;
  await guard(async () => reload(await api.createWorkspace(name || undefined)));
}

async function renameWorkspace(ws: Workspace): Promise<void> {
  const name = await ask("工作区名字", ws.name);
  if (name === null) return;
  await guard(async () => reload(await api.renameWorkspace(ws.id, name)));
}

async function renameSurface(s: Surface): Promise<void> {
  const title = await ask("会话名字（留空 = 恢复自动跟随）", s.pinned ? s.title : "");
  if (title === null) return;
  await guard(async () => reload(await api.rename(s.id, title)));
}

function navigate(delta: 1 | -1): void {
  const target = step(navWorkspaces(), currentSurfaceId(), delta);
  if (!target || !state) return;
  if (target.workspaceId !== state.activeWorkspace) {
    state.activeWorkspace = target.workspaceId;
    void api.activateWorkspace(target.workspaceId);
  }
  const w = state.workspaces.find((x) => x.id === target.workspaceId)!;
  const leaf = wsLeaves(w).find((l) => l.id === target.leafId)!;
  leaf.active = target.surfaceId;
  w.focusedLeaf = leaf.id;
  render(true);
  void api.activateTab(leaf.id, target.surfaceId, w.id);
}

function cycleTab(delta: 1 | -1): void {
  const leaf = focusedLeaf();
  if (!leaf || leaf.tabs.length < 2) return;
  const at = leaf.tabs.indexOf(leaf.active ?? "");
  const next = leaf.tabs[(at + delta + leaf.tabs.length) % leaf.tabs.length];
  selectTab(leaf.id, next);
}

function cycleLeaf(delta: 1 | -1): void {
  const w = activeWs();
  if (!w) return;
  const ls = wsLeaves(w);
  if (ls.length < 2) return;
  const at = ls.findIndex((l) => l.id === w.focusedLeaf);
  focusLeaf(ls[(at + delta + ls.length) % ls.length].id);
}

function currentView(): TermView | null {
  const id = currentSurfaceId();
  return id ? pool.peek(id) ?? null : null;
}

async function searchInTerm(): Promise<void> {
  const view = currentView();
  if (!view) return;
  const q = await ask("在当前终端里搜索");
  if (q) view.search.findNext(q);
}

// ——————————————————————— 快捷键 ———————————————————————

interface Binding {
  code: string;
  shift?: boolean;
  alt?: boolean;
  winCode?: string;
  desc: string;
  reserved?: boolean;
  run: () => void;
}

/**
 * Mac 用 ⌘：终端只用 Ctrl，⌘ 那一整层是空的。
 * 其它平台用 Ctrl+Shift：裸 Ctrl+字母 在终端里全都有含义，抢任何一个都等于把
 * 终端弄残。非 Mac 上 Shift 已经是修饰键的一部分，不能再拿它区分条目 ——
 * 所以 Mac 上靠 ⇧/⌥ 区分的几条在这边必须换成不同的键（winCode）。
 */
const BINDINGS: Binding[] = [
  { code: "Enter", desc: "新终端", run: () => void newSurface() },
  { code: "KeyT", desc: "新终端", reserved: true, run: () => void newSurface() },
  { code: "KeyN", desc: "新建工作区", reserved: true, run: () => void newWorkspace() },
  { code: "KeyD", desc: "左右分屏", run: () => void split("row") },
  { code: "KeyD", shift: true, winCode: "KeyE", desc: "上下分屏", run: () => void split("col") },
  {
    code: "Backspace",
    desc: "关闭当前终端",
    run: () => {
      const id = currentSurfaceId();
      if (id) void closeSurface(id);
    },
  },
  {
    code: "KeyW",
    desc: "关闭当前终端",
    reserved: true,
    run: () => {
      const id = currentSurfaceId();
      if (id) void closeSurface(id);
    },
  },
  { code: "KeyF", desc: "搜索", run: () => void searchInTerm() },
  { code: "KeyK", desc: "清屏", run: () => currentView()?.clear() },
  { code: "BracketLeft", desc: "上一个标签（本格子内）", run: () => cycleTab(-1) },
  { code: "BracketRight", desc: "下一个标签（本格子内）", run: () => cycleTab(1) },
  { code: "BracketLeft", shift: true, winCode: "Comma", desc: "上一个会话（跨工作区）", run: () => navigate(-1) },
  { code: "BracketRight", shift: true, winCode: "Period", desc: "下一个会话（跨工作区）", run: () => navigate(1) },
  { code: "BracketLeft", alt: true, winCode: "Semicolon", desc: "上一个格子", run: () => cycleLeaf(-1) },
  { code: "BracketRight", alt: true, winCode: "Quote", desc: "下一个格子", run: () => cycleLeaf(1) },
  // Ctrl+Shift+R 是 Chrome 的强制刷新，拦不住，非 Mac 换成 M
  {
    code: "KeyR",
    winCode: "KeyM",
    desc: "重命名工作区",
    run: () => {
      const w = activeWs();
      if (w) void renameWorkspace(w);
    },
  },
  {
    code: "KeyR",
    shift: true,
    winCode: "KeyY",
    desc: "重命名当前会话",
    run: () => {
      const id = currentSurfaceId();
      const s = id ? surfaceById(id) : null;
      if (s) void renameSurface(s);
    },
  },
  { code: "KeyF", shift: true, winCode: "KeyG", desc: "进/退键盘独占", run: () => void toggleExclusive() },
  { code: "Slash", desc: "快捷键一览", run: () => toggleHelp() },
];

function keyLabel(b: Binding): string {
  if (IS_MAC) {
    const glyph =
      { Enter: "⏎", Backspace: "⌫", BracketLeft: "[", BracketRight: "]", Slash: "/" }[
        b.code
      ] ?? b.code.replace(/^Key/, "");
    return `${b.shift ? "⇧" : ""}${b.alt ? "⌥" : ""}⌘${glyph}`;
  }
  const code = b.winCode ?? b.code;
  const glyph =
    {
      Enter: "Enter",
      Backspace: "Backspace",
      BracketLeft: "[",
      BracketRight: "]",
      Slash: "/",
      Comma: ",",
      Period: ".",
      Semicolon: ";",
      Quote: "'",
    }[code] ?? code.replace(/^Key/, "");
  return `Ctrl+Shift+${glyph}`;
}

/**
 * 用捕获阶段监听 window：xterm 是在它自己的 textarea 上收 keydown 的，
 * 等冒泡到 window 再拦就晚了 —— ⌘D 会先被当成普通输入送进终端。
 *
 * 按键匹配一律用 code，不用 key：Mac 上 ⌥[ 送出来的 key 是 "“"，
 * 按 key 匹配的话带 ⌥ 的绑定永远匹配不上。
 */
window.addEventListener(
  "keydown",
  (e) => {
    if (document.querySelector(".ask")) return; // 输入框自己处理
    if (e.key === "Escape") {
      closeMenu();
      $("#help").parentElement?.classList.contains("mask") && closeHelp();
      return;
    }

    if (IS_MAC ? !e.metaKey || e.ctrlKey : !(e.ctrlKey && e.shiftKey) || e.metaKey) {
      return;
    }

    // 切到第 N 个工作区
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit && (IS_MAC ? !e.shiftKey && !e.altKey : true)) {
      const ws = state?.workspaces[Number(digit[1]) - 1];
      if (ws) {
        e.preventDefault();
        switchWorkspace(ws.id);
      }
      return;
    }

    for (const b of BINDINGS) {
      const code = IS_MAC ? b.code : b.winCode ?? b.code;
      if (e.code !== code) continue;
      if (IS_MAC) {
        if (Boolean(b.shift) !== e.shiftKey) continue;
        if (Boolean(b.alt) !== e.altKey) continue;
      } else if (e.altKey) {
        continue;
      }
      e.preventDefault();
      e.stopPropagation();
      b.run();
      return;
    }
  },
  true,
);

// ——————————————————————— 快捷键面板 ———————————————————————

function toggleHelp(): void {
  if (document.querySelector("#help")) return closeHelp();
  const mask = el("div", "mask");
  const box = el("div");
  box.id = "help";
  box.appendChild(el("h3", undefined, "快捷键"));

  const row = (label: string, desc: string, need = false) => {
    const r = el("div", "help-row");
    const k = el("kbd", undefined, label);
    r.appendChild(k);
    r.appendChild(el("div", "desc", desc));
    if (need) r.appendChild(el("div", "need", "需独占键盘"));
    return r;
  };

  box.appendChild(row(IS_MAC ? "⇧⏎" : "Shift+Enter", "Claude Code / Codex 输入框换行"));
  for (const b of BINDINGS) box.appendChild(row(keyLabel(b), b.desc, b.reserved));
  box.appendChild(row(IS_MAC ? "⌘1…9" : "Ctrl+Shift+1…9", "切到第 N 个工作区", true));

  mask.appendChild(box);
  mask.addEventListener("mousedown", (e) => {
    if (e.target === mask) closeHelp();
  });
  document.body.appendChild(mask);
}

function closeHelp(): void {
  document.querySelector("#help")?.parentElement?.remove();
  render(false);
}

// ——————————————————————— 键盘独占 ———————————————————————

const LOCKED_KEYS = [
  // Esc 必须锁：不锁的话它归浏览器管，全屏下按一下就退出独占，
  // 而 Esc 在终端里是最高频的键之一。锁上之后退出全屏改成长按 Esc。
  "Escape",
  "KeyT",
  "KeyN",
  "KeyW",
  "Digit1", "Digit2", "Digit3", "Digit4", "Digit5",
  "Digit6", "Digit7", "Digit8", "Digit9",
  "KeyR",
  "KeyD",
  "KeyF",
  "KeyK",
];

let exclusive = false;

async function toggleExclusive(): Promise<void> {
  if (exclusive) {
    try {
      await document.exitFullscreen();
    } catch {
      /* 忽略 */
    }
    (navigator as any).keyboard?.unlock?.();
    exclusive = false;
    paintExclusive();
    return;
  }

  const kb = (navigator as any).keyboard;
  if (!kb?.lock) {
    // ⌘T/⌘N/⌘W 是浏览器保留键，preventDefault 对它们无效，唯一正规出路是
    // Keyboard Lock —— 而那个 API 只在安全上下文（https 或 localhost）里存在
    paintExclusive(window.isSecureContext ? "unsupported" : "insecure");
    return;
  }
  try {
    await document.documentElement.requestFullscreen();
    // 已经注册过一个锁时直接再 lock 会抛 InvalidStateError，结果就是
    // 「看着进了独占，其实一个键都没锁住」（T-25）
    kb.unlock();
    await kb.lock(LOCKED_KEYS);
    exclusive = true;
    paintExclusive();
  } catch (err: any) {
    exclusive = false;
    paintExclusive(String(err?.message ?? err));
  }
}

function paintExclusive(err?: string): void {
  const box = $("#exclusive");
  box.classList.toggle("on", exclusive);
  const label = box.querySelector(".label")!;
  const hint = box.querySelector(".hint")!;
  const kbd = box.querySelector("kbd")!;
  label.textContent = exclusive ? "退出独占" : "键盘独占";
  kbd.textContent = IS_MAC ? "⇧⌘F" : "Ctrl+Shift+G";
  // 锁没锁上用户是感觉不到的，直到按了 ⌘T 发现开了个浏览器标签页
  hint.textContent = err
    ? err === "insecure"
      ? "需要 https 或 localhost"
      : err === "unsupported"
        ? "这个浏览器不支持 Keyboard Lock"
        : err
    : exclusive
      ? "Esc 归终端，长按退出"
      : IS_MAC
        ? "⌘T · ⌘N · ⌘1…9 需要它"
        : "Ctrl+Shift+T · N · 1…9 需要它";
}

document.addEventListener("fullscreenchange", () => {
  // 用户按 Esc 退出全屏时浏览器会自动解锁，按钮状态得跟上
  if (!document.fullscreenElement && exclusive) {
    exclusive = false;
    (navigator as any).keyboard?.unlock?.();
    paintExclusive();
  }
});

// ——————————————————————— 剪贴板与图片 ———————————————————————

/**
 * 不能直接用 navigator.clipboard.writeText：自签名 HTTPS、权限策略或浏览器设置
 * 都可能让它拒绝，而把异常静默吞掉后还 preventDefault，用户看到的就是
 * 「按了复制但什么也没有」（T-16）。这里走同步的临时 textarea + execCommand。
 */
function copyViaTextarea(text: string): boolean {
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  active?.focus();
  return ok;
}

window.addEventListener(
  "keydown",
  (e) => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (!mod) return;
    const view = currentView();
    if (!view) return;

    if (e.code === "KeyC") {
      const sel = view.selection;
      if (!sel) return; // 没选中就放行，让 Ctrl+C 去当 SIGINT
      e.preventDefault();
      if (copyViaTextarea(sel)) return;
      navigator.clipboard?.writeText(sel).catch(() => toast("浏览器不让复制", true));
      return;
    }

    if (e.code === "KeyV") {
      e.preventDefault();
      void pasteFromClipboard(view);
    }
  },
  true,
);

async function pasteFromClipboard(view: TermView): Promise<void> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const mime = item.types.find((t) => t.startsWith("image/"));
      if (mime) {
        await uploadImage(view, await item.getType(mime), mime);
        return;
      }
    }
  } catch {
    /* 没权限或没有 image，退回纯文本 */
  }
  try {
    view.paste(await navigator.clipboard.readText());
  } catch {
    toast("浏览器不让读剪贴板", true);
  }
}

async function uploadImage(view: TermView, blob: Blob, mime: string): Promise<void> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  await guard(async () => {
    const { path } = await api.pasteImage(view.surfaceId, mime, btoa(bin));
    // 路径后面不带回车，让用户自己决定这行怎么用
    view.paste(path + " ");
  });
}

// 拖入图片。只认带 Files 的拖放，别和「拖标签换格子」打架
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file || !file.type.startsWith("image/")) return;
  e.preventDefault();
  const view = currentView();
  if (view) void uploadImage(view, file, file.type);
});

// ——————————————————————— 启动 ———————————————————————

window.addEventListener("resize", () => pool.forEach((v) => v.fitAndResize()));

// 隐藏标签页里 rAF 不跑，回到前台时补一次（T-28）
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const visible = visibleSurfaces();
  pool.forEach((v) => {
    if (visible.has(v.surfaceId)) v.revive();
  });
});

$("#exclusive .row").addEventListener("click", () => void toggleExclusive());
paintExclusive();

subscribeSurfaces((list) => {
  if (!state) return;
  state.surfaces = list;
  const alive = new Set(list.map((s) => s.id));
  // 后端只推事实，不推「未读」—— 会话没了要顺带把布局里的空标签也摘掉
  let dropped = false;
  for (const w of state.workspaces) {
    for (const leaf of leavesOf(w.layout)) {
      const kept = leaf.tabs.filter((t) => alive.has(t));
      if (kept.length !== leaf.tabs.length) {
        dropped = true;
        leaf.tabs = kept;
        if (!leaf.active || !alive.has(leaf.active)) leaf.active = kept[0] ?? null;
      }
    }
  }
  if (dropped) void reload();
  else render(false);
});

void reload().catch((err) => toast(String(err?.message ?? err), true));
