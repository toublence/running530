#!/usr/bin/env bash
# shellcheck disable=SC1090
#
# macOS에서 Android 빌드를 할 때 필요한 공통 환경 변수를 모아둔 스크립트입니다.
# `source scripts/android-env.sh` 형태로 불러와 ANDROID_SDK_ROOT, PATH, JAVA_HOME을 맞춰주세요.

if [[ "${OSTYPE:-}" != darwin* ]]; then
  # 다른 OS에서는 아무 작업도 하지 않음
  return 0 2>/dev/null || exit 0
fi

if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  _android_env_source="${BASH_SOURCE[0]}"
elif [[ -n "${ZSH_VERSION:-}" ]]; then
  _android_env_source="${(%):-%x}"
else
  _android_env_source="$0"
fi

SCRIPT_DIR="$(cd "$(dirname "${_android_env_source}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOLS_NODE_BIN="$PROJECT_ROOT/scripts/.tools/node/bin"

if [[ -x "$TOOLS_NODE_BIN/node" ]]; then
  case ":$PATH:" in
    *":$TOOLS_NODE_BIN:"*) ;;
    *) PATH="$TOOLS_NODE_BIN:$PATH" ;;
  esac
fi

ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT

CMDLINE_TOOLS_BIN="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin"
PLATFORM_TOOLS_BIN="$ANDROID_SDK_ROOT/platform-tools"

case ":$PATH:" in
  *":$CMDLINE_TOOLS_BIN:"*) ;;
  *) PATH="$CMDLINE_TOOLS_BIN:$PATH" ;;
esac

case ":$PATH:" in
  *":$PLATFORM_TOOLS_BIN:"*) ;;
  *) PATH="$PLATFORM_TOOLS_BIN:$PATH" ;;
esac

export PATH

if command -v /usr/libexec/java_home >/dev/null 2>&1; then
  if JAVA_HOME_17=$(/usr/libexec/java_home -v 17 2>/dev/null); then
    export JAVA_HOME="$JAVA_HOME_17"
  fi
fi
