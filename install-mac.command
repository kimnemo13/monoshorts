#!/bin/bash
# ============================================================
#  monoshorts 설치 (macOS)
#  실행: 터미널에  bash  입력 → 한 칸 띄우고 → 이 파일을 끌어다 놓고 → Enter
#  - 이 폴더의 파일을 프리미어 확장 폴더로 "복사"해서 설치합니다.
#  - 이미 설치돼 있으면 덮어쓰되, 내 설정(하단 이미지·저장 폴더 등)은 그대로 둡니다.
#  - 설치 후 업데이트는 패널을 열 때 GitHub에서 자동으로 받습니다.
# ============================================================
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DST_ROOT="$HOME/Library/Application Support/Adobe/CEP/extensions"
DST="$DST_ROOT/com.monostudio.monoshorts"

echo ""
echo "=== monoshorts 설치 ==="

if pgrep -xq "Adobe Premiere Pro" 2>/dev/null || pgrep -fq "Adobe Premiere Pro.app" 2>/dev/null; then
  echo "※ 프리미어가 켜져 있어요. 설치가 끝나면 프리미어를 완전히 종료(⌘Q)했다가 다시 켜 주세요."
fi

# 1) 내 설정 파일 잠시 보관 (예전 링크 방식 설치여도 따라가서 가져옴)
KEEP="$(mktemp -d)"
for f in sm-settings.json wrap-undo.json last-export-log.txt; do
  [ -e "$DST/$f" ] && cp -L "$DST/$f" "$KEEP/$f" 2>/dev/null || true
done

# 2) 예전 설치 제거 (링크면 링크만 지움 — 원본 폴더는 안전)
mkdir -p "$DST_ROOT"
rm -rf "$DST_ROOT/com.monostudio.shortsmaker"
if [ -L "$DST" ]; then rm -f "$DST"; else rm -rf "$DST"; fi

# 3) 복사 설치
mkdir -p "$DST"
rsync -a --exclude '.git' --exclude '.DS_Store' "$SRC/" "$DST/"
cp -p "$KEEP"/* "$DST/" 2>/dev/null || true
rm -rf "$KEEP"
xattr -dr com.apple.quarantine "$DST" 2>/dev/null || true
echo "[1/2] 확장 설치 완료 → $DST"

# 4) 서명 안 된 확장 로드 허용
for v in 9 10 11 12 13 14; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done
killall cfprefsd 2>/dev/null || true
echo "[2/2] 프리미어 확장 허용 설정 완료"

VER="$(grep -o '"version": *"[^"]*"' "$DST/version.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
echo ""
echo "✅ monoshorts v$VER 설치 완료"
echo "   1) 프리미어를 완전히 종료(⌘Q)했다가 다시 켜세요."
echo "   2) 창(Window) > 확장명(Extensions) > monoshorts"
echo "   이후 업데이트는 패널을 열 때 자동으로 적용됩니다."
echo ""
