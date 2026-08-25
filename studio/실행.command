#!/bin/bash
# PRIZM 콘텐츠 스튜디오 실행 (더블클릭)
cd "$(dirname "$0")" || exit 1
# 더블클릭 시 PATH가 최소라 node 경로를 직접 탐지
NODE="$(command -v node)"
for p in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
  [ -z "$NODE" ] && [ -x "$p" ] && NODE="$p"
done
if [ -z "$NODE" ]; then echo "node를 찾을 수 없습니다. Node.js 18+ 설치가 필요합니다."; read -r _; exit 1; fi
echo "▶ PRIZM 콘텐츠 스튜디오 시작…"
( sleep 1.5; open "http://localhost:8790" ) &
exec "$NODE" server.js
