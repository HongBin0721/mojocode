#!/bin/sh
# mojocode 单二进制安装脚本(macOS / Linux)。
#
#   curl -fsSL https://raw.githubusercontent.com/HongBin0721/mojocode/main/install.sh | sh
#
# 探测平台 → 从 GitHub Releases 下载对应归档 → sha256 校验 → 装到
# ~/.local/bin/mojocode。Windows 用户请到 Releases 页手动下载 zip。
# 环境变量:
#   MOJOCODE_VERSION      指定版本(默认 latest,形如 v0.1.2)
#   MOJOCODE_INSTALL_DIR  安装目录(默认 ~/.local/bin)
set -eu

REPO="HongBin0721/mojocode"
VERSION="${MOJOCODE_VERSION:-latest}"
INSTALL_DIR="${MOJOCODE_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "错误:$1" >&2
  exit 1
}

# ---- 平台探测 --------------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "不支持的系统 $os(Windows 请到 https://github.com/$REPO/releases 手动下载 zip)" ;;
esac
case "$arch" in
  arm64 | aarch64) cpu="arm64" ;;
  x86_64 | amd64) cpu="x64" ;;
  *) fail "不支持的架构 $arch" ;;
esac

target="$platform-$cpu"
# musl 系统(Alpine 等)用静态链接产物;ldd 不存在或输出含 musl 都算。
if [ "$platform" = "linux" ]; then
  if ! command -v ldd >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; then
    [ "$cpu" = "x64" ] || fail "linux-$cpu 暂无 musl 产物,请用 glibc 环境或从源码运行"
    target="linux-x64-musl"
  fi
fi

asset="mojocode-$target.tar.gz"
if [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

# ---- 下载 + 校验 -----------------------------------------------------------
command -v curl >/dev/null 2>&1 || fail "需要 curl"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "下载 $asset($VERSION)..."
curl -fsSL -o "$tmp/$asset" "$base/$asset" || fail "下载失败:$base/$asset"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "下载校验和失败"

expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | awk '{print $1}')"
[ -n "$expected" ] || fail "SHA256SUMS 里找不到 $asset"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
fi
[ "$actual" = "$expected" ] || fail "sha256 校验不通过(期望 $expected,实际 $actual)"

# ---- 安装 ------------------------------------------------------------------
tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$INSTALL_DIR"
install -m 755 "$tmp/mojocode" "$INSTALL_DIR/mojocode"

echo "已安装:$INSTALL_DIR/mojocode($("$INSTALL_DIR/mojocode" --version))"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "提示:$INSTALL_DIR 不在 PATH 里,加一行到 shell 配置:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
