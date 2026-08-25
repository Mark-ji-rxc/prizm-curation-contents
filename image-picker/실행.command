#!/bin/bash
# 콘텐츠 이미지 추천기 실행 (더블클릭) — 창이 보이는 방식
cd "$(dirname "$0")" || exit 1
clear
echo "🖼  콘텐츠 이미지 추천기"
echo "────────────────────────────────"

# node 경로 확보 (더블클릭 시 PATH가 최소라서 직접 추가)
for p in /opt/homebrew/bin /usr/local/bin "$HOME/.nvm/versions/node"/*/bin; do
  [ -x "$p/node" ] && export PATH="$p:$PATH"
done
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js가 필요합니다. https://nodejs.org 에서 LTS를 설치한 뒤 다시 실행하세요."
  read -n 1 -s -r -p "아무 키나 누르면 닫힙니다..."; exit 1
fi

# 설정 파일 없으면 만들고 편집기 열기
if [ ! -f nas.config.json ]; then
  cp nas.config.example.json nas.config.json
  open -e nas.config.json
  echo "⚠️  nas.config.json 을 만들었습니다. 열린 파일에 NAS 아이디/비밀번호를 입력·저장한 뒤"
  echo "    이 창을 닫고 실행 파일을 다시 더블클릭하세요."
  read -n 1 -s -r -p "아무 키나 누르면 닫힙니다..."; exit 0
fi

PORT="${PORT:-8787}"

# 이미 켜져 있으면 브라우저만 열기
if curl -s "http://localhost:$PORT/api/hotels" >/dev/null 2>&1; then
  echo "이미 실행 중입니다. 브라우저를 엽니다."
  open "http://localhost:$PORT"; exit 0
fi

# 3초 뒤 브라우저 자동 오픈
( sleep 3; open "http://localhost:$PORT" ) &

echo "브라우저가 곧 열립니다 → http://localhost:$PORT"
echo "종료하려면 이 창에서  Control(^) + C  를 누르거나 창을 닫으세요."
echo "────────────────────────────────"
node server.js
