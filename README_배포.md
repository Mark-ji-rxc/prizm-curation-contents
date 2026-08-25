# PRIZM 콘텐츠 스튜디오 — 설치 가이드 (새 사용자용)

여러 명이 각자 자기 PC에서 실행하고, **모범 콘텐츠(품질 기준)는 공유**해서 누가 뽑든 품질이 균일하게 유지되는 구조입니다.

- 콘텐츠 생성 = **본인 Claude 구독 계정**으로 처리 (별도 API 결제 없음)
- 이미지 = **NAS 읽기 전용**
- 품질 기준 = **공유 모범 코퍼스**(`prizm-curation-editor`)를 생성할 때마다 자동 반영

---

## 준비물
- macOS
- **Node.js** LTS — https://nodejs.org
- **Claude Code** + 본인 계정 로그인 (`claude login`)
- **NAS 읽기 전용 계정** (host/아이디/비밀번호)
- GitHub 접근 권한 (코드·코퍼스 저장소)

---

## 방법 A — 자동 설치(추천)

1. 코드 내려받기:
   ```bash
   git clone https://github.com/Mark-ji-rxc/prizm-curation-contents.git
   cd prizm-curation-contents
   ```
2. **`setup.command` 더블클릭** (또는 `bash setup.command`)
   - Node/Claude 확인 → 공유 코퍼스 clone → 설정파일 생성까지 자동
3. 안내에 따라 두 파일을 채웁니다:
   - `image-picker/nas.config.json` → NAS host/user/password
   - `studio/studio.config.json` → `"user"`에 본인 이메일 (referenceRepoDir은 자동 설정됨)
4. 터미널에서 한 번만: `claude login` (본인 구독 계정)
5. 다시 `setup.command` 실행 → 브라우저에서 `http://localhost:8790` 자동 오픈

---

## 방법 B — 수동 설치

1. **코드 clone**
   ```bash
   git clone https://github.com/Mark-ji-rxc/prizm-curation-contents.git
   cd prizm-curation-contents
   ```
2. **공유 모범 코퍼스 clone** (별도 저장소)
   ```bash
   git clone https://github.com/Mark-ji-rxc/prizm-curation-editor.git
   cd prizm-curation-editor && git config user.email "본인이메일" && cd ..
   ```
3. **NAS 설정**: `image-picker/nas.config.example.json` → `nas.config.json` 으로 복사 후 채우기
4. **스튜디오 설정**: `studio/studio.config.example.json` → `studio/studio.config.json` 으로 복사 후
   ```json
   { "referenceRepoDir": "<위 2번 clone한 prizm-curation-editor 절대경로>", "user": "본인이메일", "autoPull": true }
   ```
5. **Claude 로그인**: `claude login`
6. **실행**
   ```bash
   cd studio && node server.js
   ```
   → 브라우저에서 `http://localhost:8790`

---

## 첫 실행 후

1. **[상품 불러오기]** 탭에서 국내/해외 데이터를 한 번 크롤 (각 PC 최초 1회)
2. **[콘텐츠 생성]** 에서 생성 → 생성 직전 공유 코퍼스가 자동으로 최신화되어 반영됩니다

---

## 담당자(큐레이터)만 할 수 있는 것
- 잘 나온 콘텐츠를 **[📚 모범]** 으로 등록 → 자동으로 공유 저장소에 반영(push)
- 담당자 명단은 `prizm-curation-editor/curators.json`(이메일 = 그 PC의 `git config user.email`)
- **담당자 추가/변경은 언제든 가능** — curators.json 수정 후 push 하면 전원에게 적용(코드 재배포 불필요)

---

## 업데이트 받기
```bash
# 코드 업데이트
git pull
# 모범 코퍼스는 생성 시 자동 pull (수동: 앱의 [🔄 최신 모범 받기])
```

---

## 절대 하지 말 것
- `nas.config.json`, `studio.config.json`, `saved-contents.json` 등 **개인/비밀 파일은 커밋 금지** (`.gitignore`로 이미 제외됨)
- **NAS는 읽기 전용** — 쓰기/삭제 금지

## 자주 겪는 문제
- `EADDRINUSE :::8790` = 서버가 이미 떠 있음 → `lsof -ti:8790 | xargs kill` 후 재실행
- 콘텐츠 생성이 안 뜸 = `claude login` 안 됨 → 터미널에서 로그인
- 모범이 안 보임 = 코퍼스 clone/경로(`referenceRepoDir`) 확인
