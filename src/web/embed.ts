import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { api } from "./api.ts";
import { TermView } from "./term.ts";

/**
 * 单终端嵌入页，给外部工具 iframe 用。只有一个终端，没有侧栏/标签/工作区 ——
 * 「切换会话」的能力由主界面提供，嵌入场景要的恰恰是别切走。
 *
 *   /embed.html?id=<surfaceId>          直连已有会话
 *   /embed.html?name=<名字>&cwd=<目录>   按名字找，找不到就建
 */

const params = new URLSearchParams(location.search);
const root = document.getElementById("embed-root")!;

/** iframe 里白屏是最难排查的形态，出错必须把原因写在页面上。 */
function fail(msg: string): void {
  const box = document.createElement("pre");
  box.id = "err";
  box.textContent = `webmux 嵌入页出错：\n${msg}`;
  root.textContent = "";
  root.appendChild(box);
}

async function resolveSurfaceId(): Promise<string> {
  const id = params.get("id");
  const state = await api.state();

  if (id) {
    // 指定了 id 却不存在时直接报错，不静默新建
    if (!state.surfaces.some((s) => s.id === id)) {
      throw new Error(`会话 ${id} 不存在（它可能已经关掉了）`);
    }
    return id;
  }

  const name = params.get("name");
  if (!name) throw new Error("缺少参数：需要 ?id=… 或 ?name=…");

  // 按名字复用：iframe 刷新、多处嵌入看到的都是同一个 tmux 会话，进程不重启
  const found = state.surfaces.find((s) => s.pinned && s.title === name);
  if (found) return found.id;

  const created = await api.createSurface({
    title: name,
    cwd: params.get("cwd") ?? undefined,
  });
  return created.surface.id;
}

resolveSurfaceId()
  .then((surfaceId) => {
    const view = new TermView(surfaceId);
    view.mount(root);
    window.addEventListener("resize", () => view.fitAndResize());
    // iframe 场景下点到哪里都把焦点还给终端
    window.addEventListener("mouseup", () => {
      if (!window.getSelection()?.toString()) view.focus();
    });
    setTimeout(() => view.focus(), 50);
  })
  .catch((err) => fail(String(err?.message ?? err)));
