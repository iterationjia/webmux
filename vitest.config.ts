import { defineConfig } from "vitest/config";

// vite.config.ts 的 root 是 src/web（前端构建用），测试要以仓库根为准，
// 所以单独给一份 —— 否则 vitest 在 src/web 里找不到 tests/。
export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    // e2e 要起真服务 + 真 tmux，几个文件并行会互相抢 socket
    fileParallelism: false,
  },
});
