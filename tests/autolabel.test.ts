import { describe, expect, it } from "vitest";
import { autoLabel } from "../src/server/surfaces.ts";

const HOST = "build-node-07.example.internal";
const label = (cmd: string, cwd: string, id: string, pane = "") =>
  autoLabel(cmd, cwd, id, pane, HOST);

describe("autoLabel", () => {
  it("优先用自报的标题", () => {
    expect(label("node", "/home/x/webmux", "a1b2c3d4", "重构布局树")).toBe("重构布局树");
  });

  it("命令是 bash 时照样采信——Claude Code 跑起来 pane_current_command 仍是 bash", () => {
    expect(label("bash", "/home/x/webmux", "a1b2c3d4", "血缘与治理")).toBe("血缘与治理");
  });

  it("剥掉开头的 spinner／状态字符，否则标签会跟着动画一直抖", () => {
    expect(label("bash", "/home/x/webmux", "a1b2c3d4", "⠂ refactor")).toBe("refactor");
    expect(label("bash", "/home/x/webmux", "a1b2c3d4", "✳ 查看项目")).toBe("查看项目");
  });

  it("shell 的 PROMPT_COMMAND 设的 user@host:dir 不算数", () => {
    expect(label("bash", "/home/x/webmux", "a1b2c3d4", "guo@host:/home/x/webmux")).toBe(
      "webmux",
    );
  });

  it("shell 只报机器名时也不算数", () => {
    expect(label("bash", "/home/x/webmux", "a1b2c3d4", HOST)).toBe("webmux");
    expect(label("bash", "/home/x/webmux", "a1b2c3d4", "build-node-07")).toBe("webmux");
  });

  it("光是一个路径、或光是当前目录名，都不算数", () => {
    expect(label("bash", "/home/x/webmux", "a1b2c3d4", "/home/x/webmux")).toBe("webmux");
    expect(label("bash", "/home/x/webmux", "a1b2c3d4", "webmux")).toBe("webmux");
  });

  it("太长的标题会截断，不然标签栏会被一条撑满", () => {
    const out = label("bash", "/home/x/webmux", "a1b2c3d4", "标".repeat(50));
    expect(out.length).toBe(32);
    expect(out.endsWith("…")).toBe(true);
  });

  it("跑着具体命令就显示命令——这是最有信息量的", () => {
    expect(label("python3", "/home/x/webmux", "a1b2c3d4")).toBe("python3");
    expect(label("vim", "/home/x/webmux", "a1b2c3d4")).toBe("vim");
  });

  it("空闲 shell 显示目录名——「在哪」比「是 bash」有用", () => {
    expect(label("zsh", "/home/x/webmux", "a1b2c3d4")).toBe("webmux");
  });

  it("目录末尾的斜杠不影响", () => {
    expect(label("bash", "/home/x/webmux/", "a1b2c3d4")).toBe("webmux");
  });

  it("在根目录下显示 /", () => {
    expect(label("bash", "/", "a1b2c3d4")).toBe("/");
  });

  it("命令和目录都取不到时退回短 id，总比空白强", () => {
    expect(label("", "", "a1b2c3d4")).toBe("a1b2c3d4");
  });

  it("目录取不到但有 shell 名时就用 shell 名", () => {
    expect(label("bash", "", "a1b2c3d4")).toBe("bash");
  });
});
