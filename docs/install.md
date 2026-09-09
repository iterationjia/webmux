# 安装与配置

## 前置

- **tmux**（3.x）—— 没装的话 `bash scripts/install-tmux.sh`（macOS 走 brew，
  Linux 走 AppImage 装到 `~/.local/bin/tmux`，不需要 sudo）
- **Node 20+**

## 跑起来

```bash
npm install          # postinstall 会补 node-pty spawn-helper 的执行位
npm run build:web    # 前端是构建产物，改了必须重新构建
npm start            # 或 npm run dev（带热重载）
```

## 配置

全部走环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WEBMUX_TMUX` | `~/.local/bin/tmux`，没有就用 PATH 里的 | tmux 可执行文件 |
| `WEBMUX_SOCKET` | `webmux` | tmux socket 名（`-L`），必须独立于你日常用的 |
| `WEBMUX_PREFIX` | `wm_` | 会话名前缀，只认自己前缀下的会话 |
| `WEBMUX_HOST` | `127.0.0.1` | 监听地址 |
| `WEBMUX_PORT` | `7788` | 监听端口（`0` = 让系统挑一个） |
| `WEBMUX_TOKEN` | 空 | 访问令牌 |
| `WEBMUX_CWD` | `$HOME` | 新终端的默认工作目录 |
| `WEBMUX_STATE` | `~/.webmux/state.json` | 布局落盘位置 |
| `WEBMUX_SCROLLBACK` | `2000` | attach 时回灌多少行历史 |
| `WEBMUX_TLS_CERT` / `WEBMUX_TLS_KEY` | 空 | 两个都给才开 HTTPS |

## 从别的机器访问

```bash
WEBMUX_HOST=0.0.0.0 WEBMUX_TOKEN=$(openssl rand -hex 16) npm start
```

**监听非回环地址却不设令牌时，服务会直接拒绝启动。** 这是个完整的远程 shell，
没有别的门槛。

第一次打开带上 `?token=…`，之后会种 cookie，再进就不用带了。

## HTTPS

```bash
bash scripts/make-cert.sh          # 生成自签证书到 ~/.webmux
WEBMUX_TLS_CERT=~/.webmux/cert.pem WEBMUX_TLS_KEY=~/.webmux/key.pem npm start
```

除了更安全，还有一个实际理由：**键盘独占**（抢回 `⌘T`、`⌘N`、`⌘W`、`⌘1…9`）
依赖浏览器的 Keyboard Lock，而那个能力只在安全上下文里存在——https 或 localhost，
自签证书也算数。

## 同一台机器跑多份

错开这四个就行：

```bash
WEBMUX_PORT=7799 WEBMUX_SOCKET=webmux_b WEBMUX_PREFIX=wmb_ \
WEBMUX_STATE=~/.webmux/state-b.json npm start
```

## 嵌入到别的页面

```
/embed.html?id=<surfaceId>            直连已有会话
/embed.html?name=<名字>&cwd=<目录>     按名字找，找不到就建
```

两者都可以带 `&token=…`。按名字复用意味着 iframe 刷新、多处嵌入看到的都是
同一个 tmux 会话，进程不重启。

## 开发

```bash
npm test          # 93 个用例
npm run typecheck
npm run dev:web   # 前端 dev server，/api 与 /ws 代理到 7788
```

`DESIGN.md` 记选型理由，`docs/gotchas.md` 记踩过的坑。
