import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        // 必须给绝对路径：root 已经是 src/web，相对路径会被再拼一次
        index: resolve(import.meta.dirname, "src/web/index.html"),
        embed: resolve(import.meta.dirname, "src/web/embed.html"),
      },
    },
  },
  server: {
    port: 7789,
    proxy: {
      "/api": "http://127.0.0.1:7788",
      "/ws": { target: "ws://127.0.0.1:7788", ws: true },
    },
  },
});
