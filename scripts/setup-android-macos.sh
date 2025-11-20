#!/usr/bin/env bash
set -euo pipefail

if [[ "${OSTYPE:-}" != darwin* ]]; then
  echo "이 스크립트는 macOS에서만 사용할 수 있습니다." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOLS_DIR="$PROJECT_ROOT/scripts/.tools"
NODE_VERSION="v20.17.0"
NODE_DIST="node-${NODE_VERSION}-darwin-arm64"
NODE_ARCHIVE="$TOOLS_DIR/${NODE_DIST}.tar.xz"
NODE_INSTALL_DIR="$TOOLS_DIR/$NODE_DIST"
NODE_LINK="$TOOLS_DIR/node"

command -v brew >/dev/null 2>&1 || {
  echo "Homebrew가 필요합니다. https://brew.sh 를 참고해 설치해 주세요." >&2
  exit 1
}

ensure_cask() {
  local name="$1"
  if ! brew list --cask "$name" >/dev/null 2>&1; then
    echo "▶ brew install --cask $name"
    brew install --cask "$name"
  else
    echo "✔ $name 이미 설치됨"
  fi
}

ensure_java17() {
  if /usr/libexec/java_home -v 17 >/dev/null 2>&1; then
    echo "✔ JDK 17 감지됨: $(/usr/libexec/java_home -v 17 2>/dev/null)"
  else
    ensure_cask temurin@17
  fi
}

ensure_android_cmdline_tools() {
  local sdk_root="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
  local sdkmanager_bin="$sdk_root/cmdline-tools/latest/bin/sdkmanager"
  if [[ -x "$sdkmanager_bin" ]]; then
    echo "✔ Android command-line tools 발견됨 ($sdkmanager_bin)"
  else
    ensure_cask android-commandlinetools
  fi
}

ensure_node20() {
  mkdir -p "$TOOLS_DIR"
  if [[ ! -x "$NODE_INSTALL_DIR/bin/node" ]]; then
    echo "▶ Node.js ${NODE_VERSION} 다운로드"
    curl -L -o "$NODE_ARCHIVE" "https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.xz"
    echo "▶ Node.js ${NODE_VERSION} 압축 해제"
    tar -xJf "$NODE_ARCHIVE" -C "$TOOLS_DIR"
    rm -f "$NODE_ARCHIVE"
  else
    echo "✔ Node.js ${NODE_VERSION} 바이너리 준비됨"
  fi
  ln -sfn "$NODE_INSTALL_DIR" "$NODE_LINK"
  PATH="$NODE_LINK/bin:$PATH"
  export PATH
  if [[ "$(node -v)" != "${NODE_VERSION}" ]]; then
    echo "Node.js ${NODE_VERSION} 실행에 실패했습니다." >&2
    exit 1
  fi
}

ensure_node20

ensure_java17

ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT
mkdir -p "$ANDROID_SDK_ROOT"

ensure_android_cmdline_tools

if [[ ! -x /usr/libexec/java_home ]]; then
  echo "/usr/libexec/java_home 명령을 찾을 수 없습니다." >&2
  exit 1
fi

JAVA_HOME_17=$(/usr/libexec/java_home -v 17 2>/dev/null || true)
if [[ -z "$JAVA_HOME_17" ]]; then
  echo "JDK 17(Temurin)이 올바르게 설치되지 않았습니다." >&2
  exit 1
fi
export JAVA_HOME="$JAVA_HOME_17"

PATH="$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$PATH"
export PATH

SDKMANAGER_BIN="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
if [[ ! -x "$SDKMANAGER_BIN" ]]; then
  if command -v sdkmanager >/dev/null 2>&1; then
    SDKMANAGER_BIN="$(command -v sdkmanager)"
  else
    echo "sdkmanager를 찾을 수 없습니다. ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager 경로를 확인하세요." >&2
    exit 1
  fi
fi

REQUIRED_PACKAGES=(
  "cmdline-tools;latest"
  "platform-tools"
  "platforms;android-35"
  "build-tools;35.0.0"
)

echo "▶ sdkmanager --licenses"
yes | "$SDKMANAGER_BIN" --licenses >/dev/null || true

echo "▶ sdkmanager ${REQUIRED_PACKAGES[*]}"
yes | "$SDKMANAGER_BIN" "${REQUIRED_PACKAGES[@]}" || true

LOCAL_PROPERTIES_PATH="$PROJECT_ROOT/frontend/android/local.properties"
ESCAPED_SDK_DIR=${ANDROID_SDK_ROOT// /\\ }
cat > "$LOCAL_PROPERTIES_PATH" <<EOF
sdk.dir=$ESCAPED_SDK_DIR
EOF

cat <<'EOF'
✅ macOS용 Android 빌드 환경 설정이 완료되었습니다.

다음 명령으로 환경 변수를 적용하세요:

  source scripts/android-env.sh

그런 다음 아래와 같이 빌드를 실행하면 윈도우와 동일한 결과를 얻을 수 있습니다.

  pushd frontend/android >/dev/null
  ./gradlew assembleRelease
  popd >/dev/null
EOF
