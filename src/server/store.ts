import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import {
  makeLeaf,
  reconcile,
  surfaceIds,
  type LayoutNode,
  type Workspace,
} from "./layout.ts";
import { newLeafId, newWorkspaceId } from "./surfaces.ts";

export const VERSION = 1;

export interface StateFile {
  version: number;
  workspaces: Workspace[];
  activeWorkspace: string;
}

export function emptyState(): StateFile {
  const leaf = makeLeaf(newLeafId());
  const ws: Workspace = {
    id: newWorkspaceId(),
    name: "默认",
    layout: leaf,
    focusedLeaf: leaf.id,
  };
  return { version: VERSION, workspaces: [ws], activeWorkspace: ws.id };
}

/**
 * 空工作区会被自动收掉，但至少留一个（INV-4/5）。
 * 所以「新建工作区」必须在同一个请求里把第一个终端也建出来。
 */
export function pruneEmpty(state: StateFile): StateFile {
  if (state.workspaces.length <= 1) return state;
  let kept = state.workspaces.filter((w) => surfaceIds(w.layout).length > 0);
  if (kept.length === 0) kept = [state.workspaces[0]];
  const active = kept.some((w) => w.id === state.activeWorkspace)
    ? state.activeWorkspace
    : kept[0].id;
  return { ...state, workspaces: kept, activeWorkspace: active };
}

export class Store {
  private state: StateFile;
  /** 并发的 save 会互相覆盖，也可能让文件半新半旧。 */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {
    this.state = this.read();
  }

  private read(): StateFile {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as StateFile;
      // 版本对不上/解析失败/workspaces 为空 → 直接重置。
      // 状态文件是可再生的（布局而已），为它写迁移不值当。
      if (raw?.version !== VERSION) return emptyState();
      if (!Array.isArray(raw.workspaces) || raw.workspaces.length === 0) {
        return emptyState();
      }
      return raw;
    } catch {
      return emptyState();
    }
  }

  get(): StateFile {
    return this.state;
  }

  set(next: StateFile): StateFile {
    this.state = next;
    this.save();
    return this.state;
  }

  activeWs(): Workspace {
    return (
      this.state.workspaces.find((w) => w.id === this.state.activeWorkspace) ??
      this.state.workspaces[0]
    );
  }

  wsById(id?: string): Workspace {
    if (!id) return this.activeWs();
    return this.state.workspaces.find((w) => w.id === id) ?? this.activeWs();
  }

  /** 每次读状态都跑一遍：从 SSH 手工 kill 掉的会话不会在网页上留下空标签（INV-1/2）。 */
  sync(alive: Iterable<string>): StateFile {
    const set = new Set(alive);
    const workspaces = this.state.workspaces.map((w) => {
      const layout = reconcile(w.layout, set);
      const ids = new Set(layoutLeafIds(layout));
      return {
        ...w,
        layout,
        focusedLeaf: ids.has(w.focusedLeaf) ? w.focusedLeaf : firstLeafId(layout),
      };
    });
    return this.set(pruneEmpty({ ...this.state, workspaces }));
  }

  /** 落盘失败不抛错：布局丢了顶多下次重排，会话都还在。 */
  private save(): void {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writing = this.writing.then(async () => {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        // 原子写：断电不会留下半个 JSON
        const tmp = `${this.file}.${process.pid}.tmp`;
        writeFileSync(tmp, snapshot, "utf8");
        try {
          renameSync(tmp, this.file);
        } catch (err) {
          try {
            unlinkSync(tmp);
          } catch {
            /* 忽略 */
          }
          throw err;
        }
      } catch {
        /* 忽略 */
      }
    });
  }

  async flush(): Promise<void> {
    await this.writing;
  }
}

export function layoutLeafIds(node: LayoutNode): string[] {
  return node.kind === "leaf"
    ? [node.id]
    : [...layoutLeafIds(node.a), ...layoutLeafIds(node.b)];
}

export function firstLeafId(node: LayoutNode): string {
  return node.kind === "leaf" ? node.id : firstLeafId(node.a);
}
