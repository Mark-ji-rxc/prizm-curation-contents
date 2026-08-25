#!/bin/bash
# ─────────────────────────────────────────────────────────────
# PRIZM 콘텐츠 스튜디오 — 설치/실행 (더블클릭)
# 최초 실행 시: 설정파일 생성 + 공유 코퍼스 clone, 이후: 서버 실행
# ─────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
CURATION_URL="https://github.com/Mark-ji-rxc/prizm-curation-editor.git"

echo "▶ PRIZM 콘텐츠 스튜디오 설치/실행"
echo "  위치: $ROOT"
echo ""

# 1) Node 확인 (더블클릭 시 PATH가 최소라 직접 탐지)
NODE="$(command -v node)"
for p in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
  [ -z "$NODE" ] && [ -x "$p" ] && NODE="$p"
done
if [ -z "$NODE" ]; then
  echo "❌ Node.js가 없습니다. https://nodejs.org 에서 LTS 버전 설치 후 다시 실행하세요."
  read -r _; exit 1
fi
echo "✅ Node: $($NODE -v)"

# 2) Claude Code 확인 (콘텐츠 자동생성에 필요)
if command -v claude >/dev/null 2>&1; then
  echo "✅ Claude Code 감지됨  (로그인 안 돼 있으면 터미널에서:  claude login)"
else
  echo "⚠️  Claude Code(claude)가 없습니다. 콘텐츠 자동생성을 쓰려면 설치 후 'claude login' 하세요."
fi

# 3) 공유 큐레이션(모범 코퍼스) 저장소 clone
CUR="$ROOT/prizm-curation-editor"
if [ ! -d "$CUR/.git" ]; then
  echo "▶ 모범 코퍼스 저장소 clone 중… ($CURATION_URL)"
  git clone "$CURATION_URL" "$CUR" && echo "✅ 코퍼스 clone 완료" || echo "⚠️  clone 실패 — 인터넷/권한 확인 후 수동 clone 필요"
else
  echo "✅ 모범 코퍼스 저장소 존재"
fi

NEED_EDIT=0

# 4) NAS 설정 파일
if [ ! -f "image-picker/nas.config.json" ]; then
  cp "image-picker/nas.config.example.json" "image-picker/nas.config.json"
  echo "⚠️  image-picker/nas.config.json 생성됨 → NAS 접속정보(host/user/password)를 채워주세요."
  NEED_EDIT=1
fi

# 5) 스튜디오 설정 파일 (referenceRepoDir 자동, user는 git 이메일로 시도)
if [ ! -f "studio/studio.config.json" ]; then
  EMAIL="$(git config user.email 2>/dev/null)"
  "$NODE" -e '
    const fs=require("fs");
    const ex=JSON.parse(fs.readFileSync("studio/studio.config.example.json","utf8"));
    ex.referenceRepoDir=process.argv[1];
    ex.user=process.argv[2]||"";
    delete ex._설명;
    fs.writeFileSync("studio/studio.config.json", JSON.stringify(ex,null,2));
  ' "$CUR" "$EMAIL"
  echo "⚠️  studio/studio.config.json 생성됨 (referenceRepoDir 자동설정, user=${EMAIL:-미설정})"
  [ -z "$EMAIL" ] && { echo "    → studio/studio.config.json 의 \"user\"에 본인 이메일을 넣어주세요."; NEED_EDIT=1; }
fi

# 6) 설정이 필요하면 폴더 열고 대기
if [ "$NEED_EDIT" = "1" ]; then
  echo ""
  echo "──────────────────────────────────────────────"
  echo " 설정 파일을 채운 뒤 Enter를 누르면 서버가 실행됩니다."
  echo " (image-picker/nas.config.json, studio/studio.config.json)"
  echo "──────────────────────────────────────────────"
  open "$ROOT"
  read -r -p "설정을 마쳤으면 Enter (취소는 Ctrl+C): " _
fi

# 7) 서버 실행
echo ""
echo "▶ 서버 시작… http://localhost:8790"
( sleep 1.5; open "http://localhost:8790" ) &
cd studio && exec "$NODE" server.js
