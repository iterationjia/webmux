import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { MAX_IMAGE_BYTES, UploadError, saveImage } from "../src/server/upload.ts";

const dir = mkdtempSync(join(tmpdir(), "webmux-upload-"));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const b64 = PNG.toString("base64");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("图片上传", () => {
  it("存下来的就是原始字节，不是 base64", () => {
    const { path, bytes } = saveImage(dir, "image/png", b64);
    expect(bytes).toBe(PNG.length);
    expect(readFileSync(path)).toEqual(PNG);
  });

  it("连着存两张不会互相覆盖", () => {
    const a = saveImage(dir, "image/png", b64);
    const b = saveImage(dir, "image/png", b64);
    expect(a.path).not.toBe(b.path);
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);
  });

  it("按 MIME 定扩展名，jpeg 落成 .jpg", () => {
    expect(saveImage(dir, "image/jpeg", b64).path.endsWith(".jpg")).toBe(true);
    expect(saveImage(dir, "image/webp", b64).path.endsWith(".webp")).toBe(true);
  });

  it("不认识的类型直接拒——这是在往磁盘写文件", () => {
    expect(() => saveImage(dir, "application/x-sh", b64)).toThrow(UploadError);
    expect(() => saveImage(dir, "text/html", b64)).toThrow(UploadError);
  });

  it("空内容拒掉", () => {
    expect(() => saveImage(dir, "image/png", "")).toThrow(UploadError);
  });

  it("超过上限拒掉", () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1024).toString("base64");
    expect(() => saveImage(dir, "image/png", big)).toThrow(UploadError);
  });

  it("目标目录写不进去时退回 ~/.webmux/pastes，而不是让粘贴功能整个失效", () => {
    const { path } = saveImage("/no/such/dir/at/all", "image/png", b64);
    expect(path.startsWith(join(homedir(), ".webmux", "pastes"))).toBe(true);
    expect(readFileSync(path)).toEqual(PNG);
    rmSync(path, { force: true });
  });

  it("兜底这条路要快——粘一张图不该卡住", () => {
    const t0 = Date.now();
    const { path } = saveImage("/proc/self/nonexistent", "image/png", b64);
    expect(Date.now() - t0).toBeLessThan(1000);
    rmSync(path, { force: true });
  });
});
