#!/bin/bash
# 콘텐츠 이미지 추천기 종료 (더블클릭)
pkill -f "node server.js" 2>/dev/null
echo "🛑 이미지 추천기 서버를 종료했습니다."
echo "이 창은 닫으셔도 됩니다."
sleep 1
