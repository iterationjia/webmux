import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 在网页终端里跑 claude/codex 这类 agent 时，最常见的动作就是「截个图给它看」。
 * 终端传不了二进制，所以图片存到服务器上，把路径打进终端，agent 自己去读那个文件。
 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-` +
    // 毫秒级：同一秒连粘两张不会互相覆盖
    `${p(d.getMilliseconds(), 3)}`
  );
}

export interface SavedImage {
  path: string;
  bytes: number;
}

/**
 * @param dir 会话此刻所在的目录（pane_current_path，跟着 cd 走），不是建出来时那个 ——
 *            否则 agent 拿到相对路径读不到。
 *
 * 绝不对 dir 做 mkdir：它本来就存在，而 mkdir 打到 /proc 之类的特殊路径上会挂很久
 * （实测能卡 20 秒），粘一张图卡死不值当。写不进去就退回 ~/.webmux/pastes/。
 */
export function saveImage(dir: string, mime: string, base64: string): SavedImage {
  const ext = EXT[mime];
  if (!ext) throw new UploadError(`不支持的图片类型: ${mime}`); // 这是在往磁盘写文件

  const buf = Buffer.from(base64 ?? "", "base64");
  if (buf.length === 0) throw new UploadError("图片内容为空");
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new UploadError(`图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`);
  }

  const name = `pasted-${stamp()}.${ext}`;
  const target = join(dir || homedir(), name);
  try {
    writeFileSync(target, buf, { flag: "wx" }); // 绝不覆盖已有文件
    return { path: target, bytes: buf.length };
  } catch {
    // 退回而不是报错：用户可能正 cd 在 /usr 之类地方，
    // 为这个把粘贴功能整个废掉不值当。
    const fallbackDir = join(homedir(), ".webmux", "pastes");
    mkdirSync(fallbackDir, { recursive: true });
    const fallback = join(fallbackDir, name);
    writeFileSync(fallback, buf, { flag: "wx" });
    return { path: fallback, bytes: buf.length };
  }
}
