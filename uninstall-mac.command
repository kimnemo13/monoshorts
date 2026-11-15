#!/bin/bash
# monoshorts 제거 (macOS) — 실행: 터미널에서  bash uninstall-mac.command
DST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.monostudio.monoshorts"
if [ -L "$DST" ]; then rm -f "$DST"; echo "monoshorts 확장(링크)을 제거했습니다.";
elif [ -d "$DST" ]; then rm -rf "$DST"; echo "monoshorts 확장을 제거했습니다.";
else echo "설치된 monoshorts 확장이 없습니다."; fi
echo "(이미 만들어진 세로 쇼츠 시퀀스는 프로젝트에 그대로 남아 있습니다)"
