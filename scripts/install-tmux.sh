#!/usr/bin/env bash
# macOS 上直接用 brew；Linux 上系统没装且 sudo 要密码时，用 AppImage 装到
# ~/.local/bin/tmux（config.ts 的默认值就是找那里）。
set -e
if command -v tmux >/dev/null 2>&1; then
  echo "已经有了：$(command -v tmux) $(tmux -V)"
  exit 0
fi
if [ "$(uname -s)" = "Darwin" ]; then
  brew install tmux
  exit 0
fi
mkdir -p "$HOME/.local/bin"
URL="https://github.com/nelsonenzo/tmux-appimage/releases/download/3.5a/tmux.appimage"
curl -fL "$URL" -o "$HOME/.local/bin/tmux"
chmod +x "$HOME/.local/bin/tmux"
"$HOME/.local/bin/tmux" -V
