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

## ⑥ 자동 발행(백오피스 등록) 설정 — 선택
`⑥ 등록` 단계에서 **[발행 실행]** 버튼만 누르면 스튜디오가 **헤드리스 브라우저(Playwright)로 백오피스 create 폼을 채우고 저장**까지 자동 처리합니다. (Claude 개입 없음) 쓰려면 각 PC에서 1회 설정:

1. **Playwright 설치** (스튜디오 폴더에서)
   ```bash
   cd studio && npm i playwright && npx playwright install chromium
   ```
2. **백오피스 로그인 세션 저장** (비밀번호는 저장되지 않음 — 세션 쿠키만) — 환경별로 각각:
   ```bash
   node publish-login.js         # 스테이지(테스트)  → office-session.json
   node publish-login.js prod    # 프로덕션(실서버)  → office-session-prod.json
   ```
   → 열리는 브라우저에서 해당 환경 백오피스에 **직접 로그인** → 터미널 Enter → 세션 저장. (세션 만료 시 다시 실행)

### 스테이지 vs 프로덕션 (발행 대상 선택)
- `⑥ 등록` 대기목록 에디터의 **발행 대상**에서 **스테이지(테스트)** / **프로덕션(실서버)** 를 고릅니다. (기본 스테이지, 프로덕션은 빨강 강조 + 발행 시 강한 확인창)
- 각 환경은 **별도 로그인 세션**을 씁니다. 프로덕션에 등록하려면 위 `node publish-login.js prod` 로 프로덕션 세션을 먼저 저장해야 합니다.
- **노출 캘린더**도 상단에서 스테이지/프로덕션을 전환해 각 환경의 실제 게시글을 확인할 수 있습니다.
- 백오피스 주소: 스테이지 `manager-office-stage.prizm.co.kr` / 프로덕션 `manager-office.prizm.co.kr` (기본값 내장, 필요 시 `studio.config.json`의 `office.stage`/`office.prod`로 재정의)

> 설정 안 하면 [발행 실행] 시 "Playwright 미설치/세션 없음" 안내가 뜹니다. 설정 후엔 버튼 → 상태가 `⏳ 발행 중…` → `✅ 발행됨`으로 바뀝니다.
> ⚠️ 무인 자동발행이라 **잘못된 콘텐츠도 그대로 게시**될 수 있으니, 특히 **프로덕션 발행 전에는 미리보기로 반드시 확인**하세요.

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

---

## 최근 추가 기능 (요약)

**콘텐츠 생성 ②**
- **본문 길이 조정**: 기본(100~300자)·조금 길게·길게·아주 길게·직접 입력
- **지역 기반 콘텐츠**: 상품 없이 지역 자체(특산물·장점·가야 할 이유·트렌드)를 주제로. 인터넷 검색 필수. 하위 옵션 **지역 축제 포함**(소도시·검색시점 4개월 이내 축제 상세 조사). 지역/축제 콘텐츠도 그 지역 상품을 자동 매칭
- **브리프 여러 건 동시 지시(배치)**: 여러 브리프를 한 번에 넣고 병렬 생성, 결과가 카드에 누적. 탭 열어둔 채 다른 일 가능
- **🕘 최근 생성 결과 복원**: 새로고침·재접속 후에도 완료된 생성 결과를 다시 불러오기
- **인터넷 검색 기본 ON**, **추측성(미검증) 문장 주황색 표기**(발행 전 재확인용)
- 규칙: 한 콘텐츠 안 어투 일관(반말/해요체 택1)·친근한 말투(격식체 지양)·감성형(후기/장면 등)엔 가격·할인 언급 지양

**상품/쇼룸 선택 ③**
- 추천이 없거나 부족하면 **상품 검색(상품명·상품ID·지역·호텔·코드)해서 직접 추가**

**등록/발행 ⑥**
- **발행 대상 스테이지/프로덕션 선택**(기본 프로덕션, 실서버는 빨강 강조+강한 확인). 환경별 세션(`node publish-login.js` / `... prod`)
- **세션 만료 시 터미널 없이 [스튜디오에서 바로 로그인]** 버튼(브라우저 열림→로그인→자동 완료). 캘린더 배너·발행 실행에서 사용
- **발행 주체: 쇼룸/프로필/리뷰** 선택. 프로필은 백오피스 등록 프로필을 드롭다운으로 선택 + **[프로필 업데이트]**
- **필터 키워드**: 등록된 건 자동 선택, 신규는 [키워드 관리]에서 자동 등록 후 선택
- **📋 노션 리스트업**: 발행 대기목록을 국내/해외 노션 DB로 내보내 검토·컨펌(상품 ID 컬럼 포함)

**노출 캘린더 (별도 탭)**
- 백오피스 실제 게시글을 전시기간 기준으로 하루/주/월 뷰. **국내/해외·스테이지/프로덕션** 전환, 날짜별 노출중/노출 시작 수 표기
