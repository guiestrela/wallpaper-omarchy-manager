#!/usr/bin/env bash

# Local security regression checks for the wallpaper scanner and plugin
# boundary. These checks are dependency-light and do not start the desktop
# shell or modify the user's Omarchy configuration.

set -euo pipefail

repo_dir=$(cd "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_dir"

failures=0

pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }

check() {
  local label="$1"
  shift
  if "$@"; then pass "$label"; else fail "$label"; fi
}

has_text() {
  grep -Fq -- "$2" "$1"
}

count_matches() {
  local pattern="$1"
  shift
  grep -En -- "$pattern" "$@" 2>/dev/null || true
}

safe_path() {
  local value="$1"
  [[ ${#value} -le 4096 ]] || return 1
  if printf '%s' "$value" | LC_ALL=C grep -P -z -q '[\x01-\x1f\x7f]'; then
    return 1
  fi
  if printf '%s' "$value" | LC_ALL=C.UTF-8 grep -P -q '[\x{80}-\x{9f}]'; then
    return 1
  fi
  return 0
}

shell_quote() {
  local value="$1"
  value=${value//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

scan_folder() {
  local folder="$1"
  local recursive="$2"
  local depth="-maxdepth 1"
  [[ "$recursive" == true ]] && depth="-maxdepth 32"

  local quoted command
  quoted=$(shell_quote "$folder")
  command="timeout --kill-after=1s 15s find -P $quoted -xdev $depth -type f \\
    \\( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.gif' \\
    -o -iname '*.mp4' -o -iname '*.webm' -o -iname '*.mkv' -o -iname '*.mov' -o -iname '*.avi' \\
    -o -iname '*.bmp' -o -iname '*.webp' \\) -print0 2>/dev/null \\
    | LC_ALL=C grep -zav '[[:cntrl:]]' \\
    | LC_ALL=C.UTF-8 grep -zavP '[\\x{80}-\\x{9f}]' \\
    | tr '\\0' '\\n' | head -n 10000 | sort -u"
  bash -c "$command"
}

echo "Wallpaper plugin security checks"

check "service uses scoped barConfig instead of shellConfig" \
  has_text Background.qml 'lookupSettings(shell ? shell.barConfig : null, pluginId)'
check "service does not access private shellConfig" \
  test "$(grep -En 'shell\.shellConfig' Background.qml || true)" = ""
check "both scanners quote the configured folder" \
  test "$(count_matches 'find -P.*Util\.shellQuote' Background.qml BarWidget.qml | wc -l)" -eq 2
check "both scanners stay on one filesystem" \
  test "$(count_matches ' -xdev' Background.qml BarWidget.qml | wc -l)" -eq 2
check "both scanners have bounded depth" \
  test "$(count_matches 'maxdepth 32' Background.qml BarWidget.qml | wc -l)" -ge 2
check "both scanners bound output" \
  test "$(count_matches 'head -n 10000' Background.qml BarWidget.qml | wc -l)" -eq 2
check "both scanners have a timeout" \
  test "$(count_matches 'timeout --kill-after=1s 15s' Background.qml BarWidget.qml | wc -l)" -eq 2
check "both scanners filter control-bearing names while NUL-delimited" \
  test "$(count_matches 'print0.*LC_ALL=C grep -zav' Background.qml BarWidget.qml | wc -l)" -eq 2
check "user paths reject ASCII and C1 control characters" \
  test "$(grep -F -n '\u007f-\u009f' Background.qml BarWidget.qml | wc -l)" -eq 2
check "QML labels render as plain text" \
  test "$(count_matches 'textFormat: Text\.PlainText' BarWidget.qml | wc -l)" -ge 4
check "plugin QML has no network downloader" \
  test "$(grep -ERn --include='*.qml' '(^|[^[:alnum:]_])(curl|wget|nc|socat)([^[:alnum:]_]|$)' . || true)" = ""

check "safe path accepts a normal absolute path" safe_path "/home/user/Wallpapers"

control_path=$(printf '/tmp/wall\npaper')
if safe_path "$control_path"; then
  fail "safe path rejects a newline"
else
  pass "safe path rejects a newline"
fi

c1_path=$(printf '/tmp/wall\302\200paper')
if safe_path "$c1_path"; then
  fail "safe path rejects a C1 control character"
else
  pass "safe path rejects a C1 control character"
fi

long_path=$(printf '%4097s' '')
if safe_path "$long_path"; then
  fail "safe path rejects an overlong value"
else
  pass "safe path rejects an overlong value"
fi

temp_root=$(mktemp -d "${TMPDIR:-/tmp}/wallpaper-security.XXXXXX")
trap 'rm -rf -- "$temp_root"' EXIT

mkdir -p "$temp_root/in/nested" "$temp_root/outside"
touch "$temp_root/in/ok.jpg" "$temp_root/in/nested/deep.png" "$temp_root/outside/escape.jpg"
ln -s "$temp_root/outside" "$temp_root/in/link"

newline_name=$(printf 'bad\nname.jpg')
touch "$temp_root/in/$newline_name"
c1_name=$(printf 'bad\302\200name.jpg')
touch "$temp_root/in/$c1_name"

scan_output=$(scan_folder "$temp_root/in" true)
check "scanner finds ordinary files" grep -Fq "$temp_root/in/ok.jpg" <<<"$scan_output"
check "scanner finds nested files within the depth limit" grep -Fq "$temp_root/in/nested/deep.png" <<<"$scan_output"
check "scanner does not follow symlinked directories" \
  test "$(grep -F "$temp_root/outside/escape.jpg" <<<"$scan_output" || true)" = ""
check "scanner excludes newline-bearing filenames" \
  test "$(grep -F -- 'bad' <<<"$scan_output" || true)" = ""
check "scanner excludes C1-control-bearing filenames" \
  test "$(grep -F -- "$c1_name" <<<"$scan_output" || true)" = ""

marker="$temp_root/marker-from-wallpaper-scan"
dollar_sign='$'
payload_suffix="${dollar_sign}(touch marker-from-wallpaper-scan)"
payload_folder=$(printf '%s/%s' "$temp_root" "$payload_suffix")
mkdir -p "$payload_folder"
touch "$payload_folder/payload.jpg"
payload_output=$(scan_folder "$payload_folder" false)
check "quoted folder paths remain usable" grep -Fq "$payload_folder/payload.jpg" <<<"$payload_output"
check "shell metacharacters stay data" test ! -e "$marker"

if (( failures )); then
  echo "$failures security check(s) failed."
  exit 1
fi

echo "All security checks passed."
