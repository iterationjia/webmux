#!/usr/bin/env bash
# 自签证书。TLS 不只是「更安全」：⌘T 这类浏览器保留键靠 Keyboard Lock 才抢得到，
# 而那个 API 只在安全上下文里存在（https 或 localhost）。自签也算数。
set -e
DIR="${1:-$HOME/.webmux}"
mkdir -p "$DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -subj "/CN=webmux" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
echo "好了：WEBMUX_TLS_CERT=$DIR/cert.pem WEBMUX_TLS_KEY=$DIR/key.pem"
