# PRIZM 콘텐츠 스튜디오 — 작업 인수인계 (HANDOFF)

> 다른 Claude(또는 담당자)가 이 문서만 보고 이어서 작업할 수 있도록 정리한 문서.
> 위치: `contetents maker/studio/` · 무의존성 Node.js(내장 모듈만, `npm install` 불필요) · Node 18+.
> **작업 완료 시마다 이 문서를 갱신한다.** (하단 "변경 이력"에 追記)

---

## 0. 한 줄 요약

PRIZM 콘텐츠 제작 전 과정( **크롤링 → 콘텐츠 생성 → 상품 선택 → 이미지 찾기 → 미리보기 → (차후)등록** )을
한 화면(단계 위저드)으로 묶은 로컬 웹앱. 기존 크롤러 2종과 image-picker를 재사용한다.

- 실행: `cd "contetents maker/studio" && node server.js` → http://localhost:8790 (더블클릭: `실행.command`)
- 실행설정: 루트 `.claude/launch.json` 의 `prizm-studio` (포트 8790, image-picker 8787과 분리)

### ⛔ 절대 원칙 3가지
1. **NAS는 읽기 전용.** 조회/썸네일/다운로드만. 저장은 studio 로컬(`exports/`,`.thumbcache/`,`jobs/`,`state.json`)에만.
2. **AI는 API키 없이 "지금 쓰는 이 Claude(Opus)"가 처리.** 사용자가 별도 결제를 원치 않음 → 파일 기반 job 핸드셰이크(아래 3장).
3. **🚫 사용자 데이터 파일을 절대 삭제/`rm` 하지 말 것.** (테스트 정리 중 삭제하다 실제 데이터가 유실된 사고가 있었음.)
   - 보호 대상: **`saved-contents.json`, `state.json`, `schedules.json`, `reference-content.json`, `모범콘텐츠_학습.md`, `uploads/`, `.backups/`, `검색결과/`(크롤 데이터), `prizm_all_*.json`**.
   - 테스트할 땐 **다른 포트/임시 폴더**를 쓰거나, 위 파일은 건드리지 말 것. 정리 명령(`rm`)에 이 파일들을 절대 넣지 말 것.
   - `saved-contents.json`은 저장 시 `.backups/`에 타임스탬프 백업(최근 30개) + 파일 유실 시 재시작 때 최신 백업에서 **자동 복구**(`loadSaved`/`saveSaved`). 그래도 삭제는 금지.

---

## 1. 파일 구조 & 역할

| 파일 | 역할 |
|---|---|
| `server.js` | HTTP 서버·전 라우팅. 크롤 실행 레지스트리, 콘텐츠/이미지 job 생성, 이미지 프록시(썸네일 캐시), 상태 저장. |
| `crawl.js` | 크롤러 2종 child_process 실행 + 최신 산출물 로드 + 국내/해외 레코드 공통 스키마 정규화(`normalize`). 상품ID는 URL의 goods 코드에서 추출(`productIdOf`). |
| `jobs.js` | 파일 기반 job 큐: `createJob/readJob/listJobs/pending`. `jobs/<id>.json`. |
| `public/index.html` `app.js` `style.css` `preview.js` | 프론트(단계 위저드 + PRIZM 피드 카드 미리보기 3종). |
| `state.json` | 단계 간 상태(자동 생성): `{dataset, selectedContent, selectedProducts, confirmedImages, matches}`. |
| `saved-contents.json` | ⭐ 저장한(즐겨찾기) 콘텐츠 목록(자동 생성). `GET/POST/DELETE /api/saved`. |
| `uploads/` | 내가 업로드한 이미지(자동 생성). 경로 스킴 `upload:<id>`. `POST /api/upload`, `GET /api/uploads`. |
| `schedules.json` | 예약 생성 목록(자동 생성). `GET/POST/DELETE /api/schedules` 외. 서버 내 setInterval 스케줄러가 실행. |
| `reference-content.json` | 모범(참고) 콘텐츠 — 생성 시 few-shot 예시로 주입. `GET/POST/DELETE /api/references`. |
| `overseas.js` / `overseas-city-index.json` | 해외 이미지 폴더 리졸버 + 도시 인덱스 캐시. |
| `jobs/` `exports/` `.thumbcache/` | 자동 생성. Git 대상 아님. |
| `실행.command` | 더블클릭 실행(node 경로 자동 탐지 + 브라우저 오픈). |

### 재사용(수정하지 않음)
- 크롤러: `../prizm_crawler.js`(국내), `../prizm_overseas_crawler.js`(해외). child_process로 `--out 검색결과` 실행 → `검색결과/prizm_all_*.json`·`prizm_통합_*.csv`(국내), `prizm_해외_all_*.json`·`prizm_해외_통합_*.csv`(해외).
- 이미지: `../image-picker/synology.js`(FileStation 읽기전용), `../image-picker/exporter.js`(후보 썸네일 export). NAS 설정도 `../image-picker/nas.config.json` 공유.
- 콘텐츠 규칙: `../큐레이션_콘텐츠_제작가이드.md`(제목 8~16자·본문 100~300자·10가지 형·화자·상품 전체 매칭).

---

## 2. 서버 API 엔드포인트

- `GET /api/state` — 전체 상태 + 데이터셋 정보 + nasReady.
- `GET /api/themes` — 주제 프리셋(국내/해외).
- **크롤링**: `POST /api/crawl {scope:domestic|overseas|both}` → `{runId}`. `GET /api/crawl/status?runId=` → `{running,log[],result}`. `GET /api/products?source=` → 정규화 rows. `GET /api/products/download?source=` → CSV 스트림.
- **콘텐츠**: `POST /api/content/generate {scope,region?,count,topic?,form?,persona?}` → `{jobId,productCount}`(job 생성). `GET /api/content/job?id=` → `{status,items?}`. `POST /api/content/select {item}` → state 저장.
- **이미지**(image-picker 이식): `GET /api/hotels`, `/api/images?hotel=`, `/api/candidates?hotel=`, `/api/tree?path=`, `/api/list-images?path=`, `/api/thumb?path=&size=&mtime=`, `/api/original?path=`.
- **이미지 추천**: `POST /api/images/export {hotel,items[],theme,body,label}` → 후보 large썸네일 `exports/<라벨>/` 저장 + imagerec job 생성 → `{jobId,dir}`. `GET /api/images/job?id=` → `{status,picks?}`(picks는 manifest로 NAS경로 매핑됨). `POST /api/images/confirm {images[]}` → state 저장.
- **미리보기**: `GET /api/preview` → `{content, images}`.

---

## 3. ⭐ 핵심: 파일 기반 job 핸드셰이크 (Claude가 직접 처리)

프로그램은 요청 파일만 만들고, **실제 생성/추천은 Claude(Opus)가 수행**한다.

### 처리 모드 (두 가지, 기본=자동)
- **자동(기본, `AUTO_CLAUDE≠0`)**: [생성]/[추천] 시 서버가 `claude -p "<jobId 처리 지침>" --model opus --permission-mode acceptEdits` 를 **child_process로 자동 실행**(cwd=studio). 사람이 문구를 입력할 필요 없음. 이 대화와 분리된 **별도 프로세스**에서 돌고, 구독으로 동작(API 추가 결제 없음). claude 실행경로는 `resolveClaudeBin()`이 자동 탐지(`~/.local/bin/claude` 등, 더블클릭 최소 PATH 대응). 끄려면 `AUTO_CLAUDE=0 node server.js`.
- **수동(폴백)**: 자동 처리가 지연되거나 꺼진 경우 UI가 "**콘텐츠 생성 요청 처리해줘**" / "**이미지 추천 요청 처리해줘**" 문구를 노출 → 사람이 Claude Code 세션에 입력하면 아래 흐름으로 처리.

아래는 Claude(자동이든 수동이든)가 job 파일을 처리하는 실제 흐름:

### (A) 콘텐츠 생성
1. 사용자가 콘텐츠 탭에서 [콘텐츠 생성] → 서버가 `jobs/content-<ts>-<rand>.json` 을 `status:"pending"` 으로 생성.
   포함: `input{topic,count,scope,region,form,persona}`, `rules`(가이드 요약), `products`(판매중 상품 전체, 정규화), `instructions`(따라야 할 지침).
2. UI가 "**콘텐츠 생성 요청 처리해줘**" 문구 표시 → 사용자가 이 채팅에 입력.
3. **Claude가 할 일**: `jobs/` 의 최신 pending content job을 Read →
   - `input.count` = **뽑을 주제 개수**. `products` 를 전수 훑어 데이터에 실제 존재하는 **서로 다른 주제**를 count개 도출(지역/혜택[조식·라운지·디너·굿즈]/타깃/가격대 등 축을 달리). `input.topic`(주제 방향)이 있으면 참고, 비면 자동 도출.
   - 주제마다 콘텐츠 1편: 제목 8~16자, 본문 100~300자, 하우스 보이스, 본문형 다양화.
   - 각 콘텐츠에 **조건 충족 상품 전체**를 `matched`(각 상품 **productId 필수**), **hotels**(매칭 호텔/여행지 중복제거)도 채움.
   - `status:"done"`, `output.items` 채워 **같은 파일**에 저장. items 수 = input.count.
   - output 스키마: `{items:[{title,body,form,persona,hotels:[..],matched:[{productId,hotel,productName,price,url,status}]}]}`
4. UI가 `/api/content/job?id=` 폴링 → done되면 카드로 표시. 사용자가 하나 선택 → 이미지 단계.

### (B) 이미지 추천
1. 이미지 탭 [Claude 추천 받기] → `/api/images/export` 가 후보 large썸네일을 `exports/<라벨>/`(+`manifest.json`,`content.txt`)에 저장하고 `jobs/imagerec-<ts>.json` 생성.
2. UI가 "**이미지 추천 요청 처리해줘**" 표시.
3. **Claude가 할 일**: 최신 pending imagerec job을 Read → `exportDir` 폴더의 이미지들을 **Read 도구로 직접 보고**(large=정상 JPEG) 콘텐츠 주제에 맞는 걸 순위대로 선정 → `status:"done"`, `output.picks:[{file,rank,reason}]` 저장. `manifest.json` 으로 file↔NAS경로 확인.
4. UI가 `/api/images/job?id=` 폴링 → picks를 manifest로 NAS경로 매핑해 타일 **초록 테두리+순위+이유** 표시.

> ⚠️ Synology **medium 썸네일은 BMP 버그** → small(갤러리)/large(추천·라이트박스)만 사용.

---

## 4. 미리보기 3종 (preview.js) — PRIZM 피드 카드 재현

컨펌된 콘텐츠(화자>호텔 헤더, 제목, 본문 더보기) + 선택 이미지 + 매칭 상품으로:
1. **이미지+상품 등록** — 상단 이미지 1~2장(**첨부 이미지 naturalW/H로 세로형/가로형 자동 판별**) + 하단 상품칩(호텔·ID·가격).
2. **이미지 없이 상품만 등록** — Goods 캐러셀(상품 카드들, 호텔·ID·가격).
3. **이미지+상품 매칭** — 이미지 위에 상품카드 하단 오버레이.

---

## 5. 현재 상태 (검증된 것)

- ✅ 크롤링 탭: 기존 데이터로 상품 테이블(국내 1,321 / 해외 90)·CSV 다운로드. 크롤 버튼은 실제 크롤러 실행(실 API).
- ✅ 콘텐츠 생성: job 핸드셰이크로 카드 표시(제목·형·화자·본문·**매칭 호텔/여행지 칩**·**매칭 상품+상품ID**). 주제 미입력 시 **개수만큼 자동 도출**(백엔드 검증).
- ✅ 이미지 찾기: NAS 갤러리 로드(예: 그랜드머큐어 600장, 카테고리 배지)·Claude 추천 초록 하이라이트+순위+이유.
- ✅ 미리보기 3종 렌더(세로/가로 자동, 상품ID 표기).
- ✅ 상태 `state.json` 유지, 콘솔 에러 없음, 전 파일 `node --check` 통과.

## 6. TODO / 이어서 할 일

- **⑤ 등록(차후 본작업)**: 컨펌된 콘텐츠+이미지를 오피스 웹에 **API 없이 Claude in Chrome으로 등록**(이미지 포함). 현재는 "준비중" 자리 + `state.json` 내보내기만.
- 상품만 캐러셀(②)의 상품 썸네일: 현재 회색 placeholder(상품 이미지는 크롤 안 함). 필요 시 goods 이미지 크롤 추가.
- 해외 콘텐츠의 이미지 매칭: NAS는 국내 호텔 사진 중심 → 해외 여행지 매칭은 수동 폴더 지정 필요할 수 있음.
- 다중 호텔 콘텐츠의 이미지 일괄 로드/큐레이션 export(현재 호텔 셀렉트 단일 로드).

## 7. 디버깅 팁

- 문법: `node --check server.js`(각 파일).
- pending job 확인: `ls studio/jobs/*.json` → 각 파일 `status`.
- 콘텐츠 job 수동 처리 예: 최신 `content-*.json` Read → output.items 채우고 status done으로 저장.
- 정규화 확인: `node -e "console.log(require('./crawl').normalizedItems('domestic')[0])"`.
- NAS 폴더 탐색·매칭 점수 등은 `../image-picker/작업내역_HANDOFF.md` 참고(동일 synology.js).

---

## 변경 이력

- **2026-08-24 (다중 사용자 배포 Phase 1 — 코드 공유 정리)**: 여러 명이 개별 PC 실행 + 공유 모범 코퍼스로 품질 균일화. `contetents maker/`를 코드 repo로 만들기 위한 스캐폴딩 생성: `.gitignore`(비밀/개인 파일 제외 — `**/nas.config.json`·`studio/studio.config.json`·`saved-contents.json`·`saved-insights.json`·`저장콘텐츠_학습분석.md`·`state.json`·`.backups/`·`jobs/`·`exports/`·`uploads/`·`검색결과/`·`prizm_all_*.json`·`prizm-curation-editor/`·`nas-image-explorer/`·`콘텐츠 작성/`), 템플릿 `studio/studio.config.example.json`·`image-picker/nas.config.example.json`, 원클릭 `setup.command`(Node/Claude 확인→코퍼스 clone→설정파일 자동생성[referenceRepoDir 자동·user=git email]→서버 실행), `README_배포.md`(신규 사용자 온보딩). 검증: 설정생성 로직·git check-ignore로 비밀파일 제외/코드 포함 확인. **다음(Phase 2)**: 사용자가 GitHub repo(예 rxcompany/prizm-content-studio, Private) 생성 후 `git init/add/commit/push`(PAT 인증). 품질 균일 레버: 동일 코드(규칙)·Opus 고정·생성직전 gitPull 모범코퍼스·큐레이션(curators.json, 나중에 이메일 추가 가능). 미해결 논의: 개인 `saved-insights` 주입이 사용자별 편차 요인 → 원하면 공유 코퍼스로 이전+담당자전용화(Phase 4).

- **2026-08-24 (모범 모아보기 · 분류 정확도 개선/재분류)**:
  - **모범 콘텐츠 모아보기**: `renderReferences`를 본문 형별 그룹 카드(`.ref-group`/`.ref-grid`/`.ref-card`)로 개편 — 상단 "총 N편·형 M종", 형별 섹션에 제목·전체 본문·등록자/날짜·삭제. (기존 compact pick-row → 카드형.) 검증: 16편이 8개 형그룹으로 표시.
  - **분류 정확도(핵심)**: 사용자 규칙 = "국내로 생성=국내 호텔, 해외로 생성=해외 여행상품". ①**생성 scope 스탬프**: `submitGeneration`에서 `stampCat`(scope=domestic→'domestic', overseas→'overseas'; 단 productCodes/productTypes 사용 시 양쪽 데이터셋 혼합 가능성 → null로 두고 서버 매칭판정) 계산 → `pollContent(...,stampCat)`가 생성 결과 각 item에 `category` 기록 → 저장 시 `POST /api/saved`가 `...item`으로 보존. ②**기존 미분류 수동 재분류**: `POST /api/saved/categorize {id,category}`(콘텐츠 삭제 없이 category만 기록, saveSaved 백업). 프론트: 미분류 카드에 [🏨 국내 호텔]/[✈️ 해외 여행상품] 버튼(`recat`), 미분류 필터 상단에 [모두 국내로]/[모두 해외로] 일괄 버튼(`bulk-recat`). `categoryOf`는 item.category 우선. 검증: 400/401 처리, GET 65/12(0 미분류), 저장 무손상 77편, 콘솔 에러 없음.
  - ※ 사용자 증상 "미분류가 많다" = 구버전 서버(category 미전송)라 프론트가 전부 unknown 처리한 것 → **서버 재시작**하면 데이터셋 대조로 대부분 자동 분류(테스트상 65/12/0).

- **2026-08-24 (저장/모범 토글 · 저장 콘텐츠 학습 분석 · 국내/해외 분류)**:
  - **저장·모범 토글**: 카드의 ⭐저장/📚모범 버튼을 한 번 더 누르면 취소되도록 변경. `app.js toggleSave/toggleRef` — 등록 시 반환된 id를 버튼 `dataset.savedId/refId`에 저장하고 `.on` 상태 표시, 재클릭 시 `DELETE /api/saved?id=`·`/api/references?id=`로 취소 후 원복. 이를 위해 서버 `POST /api/references` 응답에 `id` 추가(기존 `saveContent`는 `toggleSave`로 대체, 저장목록 카드의 모범 버튼도 `toggleRef`).
  - **저장 콘텐츠 학습 분석**(🧠 버튼): 저장된 콘텐츠 특징을 분석해 다음 생성 품질에 반영. `POST /api/saved/analyze`→`buildAnalyzeJob`(type `analyze`, savedContents 압축 주입, 지침으로 톤/후킹/제목패턴/선호주제/적용원칙 도출) → `dispatchToClaude`. UI가 `GET /api/saved/analyze/:id` 폴링, 완료 시 `harvestAnalyzeJob`이 `saved-insights.json` + `저장콘텐츠_학습분석.md`(사람이 읽는 리포트) 기록. **생성 반영**: `buildContentJob`이 `loadSavedInsights().principles`를 `insLine`(★savedInsights)으로 generate·brief 지침에 주입 → 사용자가 좋아한 스타일로 생성. 프론트: 저장 바에 [🧠 저장 콘텐츠 학습 분석] + `#analyzeBanner`(원칙·제목패턴·톤·피할것 표시). 저장 콘텐츠 2편 미만이면 400.
  - **저장 콘텐츠 국내/해외 분류**: 저장 목록을 국내 호텔/해외 여행상품으로 필터. `GET /api/saved`가 `categorizeSaved`로 각 항목에 `category`(domestic/overseas/unknown) 부여 — `buildDomOvsIndex`(국내·해외 데이터셋의 productCode/ID Set) 대비 `matched` 상품 다수결로 판정(항목에 category 저장돼 있으면 우선). 프론트: `#savedFilter` 칩(전체/🏨국내 호텔/✈️해외 여행상품/미분류 + count)로 필터, 카드 상단 `.cat-badge`. 삭제·수정 후 `reloadSaved`로 필터·카운트 동기화.
  - **검증(포트 8791 임시서버, AUTO_CLAUDE=0)**: GET /api/saved → 77편(국내 65·해외 12) category 부여 확인, POST analyze→job 생성(count 77), 폴링 pending 정상, 2편 미만 400. 저장 콘텐츠 파일 무손상(77편) 확인. **저장 데이터 절대 미삭제**(절대원칙 3).

- **2026-08-07 (저장 콘텐츠 유실 방지)**: 테스트 정리 중 `saved-contents.json`을 `rm`으로 지워 사용자 저장 콘텐츠가 유실된 사고. 재발 방지: (1) 절대원칙 3번(사용자 데이터 파일 삭제 금지) 추가, (2) `saveSaved`가 `.backups/`에 타임스탬프 백업(최근 30개), `loadSaved`가 본 파일 유실 시 최신 백업에서 자동 복구. 검증: 저장→백업생성, 본파일 삭제→재시작→복구 확인.
- **2026-08-06 (모범 콘텐츠 git 공유 + 큐레이션)**: 여러 사용자가 각자 자기 Claude 계정으로 생성하되 **동일한 모범 코퍼스를 참고**하도록 git 공유. `studio.config.json`(이 PC 전용, 비커밋)의 `referenceRepoDir`가 공유 git 저장소(예: `../prizm-curation-editor`, remote=github rxcompany/prizm-curation-editor)를 가리키면 `REFERENCE_FILE`/`MD`가 거기로. 생성 직전 `gitPull`(autoPull)로 최신 참고. **큐레이션**: `<repo>/curators.json`의 담당자(=각 PC `git config user.email`)만 등록/삭제 가능 → 서버 `isCurator()`로 게이팅(비담당자 POST/DELETE 403), 등록 시 `gitCommitPush`로 자동 커밋·푸시. 엔드포인트 `GET /api/me`, `POST /api/references/sync`(pull). 프론트: 모범 패널에 담당자 표시·[🔄 최신 받기], `body.non-curator`로 비담당자 등록 UI 숨김. 저장소: `prizm-curation-editor/`(curators.json·reference-content.json·모범콘텐츠_학습.md·README). ※ GitHub push는 사용자 인증 필요(서버는 로컬 커밋만, push는 자격증명 있을 때). 검증: 담당자 등록→공유repo 커밋, 비담당자 403, 조회는 모두 가능, /api/me·UI 표시.
- **2026-08-04 (상품 타입 조건 · 다중선택)**: 콘텐츠 생성에 "상품 타입" 조건(프리미엄 호텔·프리미엄 리조트·라이프스타일 호텔·해외 패키지·해외 호텔·현지 투어 등, **다중선택**). `productType` 필드 신설 — 국내=쇼룸 TAG(`호텔유형`, `prizm_crawler.js`가 `row.category`로 출력 → **국내 재크롤 필요**), 해외=상품구분. `crawl.js normalize`에 productType, `server.js pickProducts`(productTypes 지정 시 양쪽 데이터셋에서 조건+타입 필터), `productTypeList()`, `GET /api/product-types`. UI: 콘텐츠 탭 "상품 타입" 칩 다중선택(`#typeChips`, `selTypes` → commonBody.productTypes). 검증: 타입목록(해외3종·count), 해외 패키지+투어=35개 필터, 칩 다중선택→payload 반영.
- **2026-08-04 (인터넷 검색 · 브리프 생성 · 학습 마크다운)**:
  - **인터넷 검색 보강**: 생성/브리프에 🔎 체크(`cWeb`→`input.webSearch`). 켜면 `dispatchToClaude`가 `--allowedTools WebSearch WebFetch` 추가 + 지침으로 사실·수치·현지 이야기 검색 반영. (느려짐) **주제 자동생성 모드**에선 `webLineGen`으로 (1)트렌드·시즌·화제 검색해 새 주제 발굴 (2)사실 확인 두 가지 모두 지시.
  - **브리프(지시)로 생성**(mode `brief`): 방향·컨셉·스토리(예: 도쿠시마 도미)를 주면 하우스 보이스로 고품질 콘텐츠 + **제목 후보(titleAlternatives, 근거 포함)** 생성. UI: 모드 탭 "브리프(지시)로 생성" + textarea + 개수. 카드에 제목 후보 표시(`.alts`).
  - **학습 마크다운**: 모범 콘텐츠 저장 시 `studio/모범콘텐츠_학습.md` 자동 생성·갱신(사람이 읽고 이어쓰는 지속 학습 자산). `writeReferenceMarkdown`(saveReferences에서 호출).
  - 검증: brief job(webSearch·titleAlternatives·WebSearch 지침), 모범 추가→md 생성, UI(브리프 탭·웹체크·제목후보).
- **2026-08-04 (품질·다양성·속도·토큰·모범콘텐츠)**:
  - **다양성·품질**: generate 지침에 "★★ 다양성·품질" 블록(같은 형이어도 제목 구문/훅 매번 다르게·틀 반복 금지, 숙소/여행지/상품 구체 실체 근거, 구매동기) 추가. 형별 획일화 방지.
  - **모범 콘텐츠(few-shot 학습)**: 실제 에디터 우수 콘텐츠를 `reference-content.json`에 등록(`GET/POST/DELETE /api/references`) → buildContentJob이 상위 6편을 `referenceExamples`로 job에 넣고 지침으로 "이 톤·완성도 학습(복붙 금지)". UI: 콘텐츠 탭 "📚 모범 콘텐츠" 패널(직접 입력) + 카드 [📚 모범] 버튼(생성/저장 카드를 모범으로 등록).
  - **속도**: ①상품 payload 압축(`compactForJob` — 긴 detail 제거, `benefits` 160자 요약) ②모델 선택 `생성 속도`(품질 Opus / 빠르게 Sonnet) → `input.model`, `dispatchToClaude`가 job별 모델 사용.
  - **토큰 사용량**: `dispatchToClaude`가 `--output-format json`으로 실행, 결과 usage(input/cache/output 토큰·$·시간) 파싱해 `job.usage` 기록. `/api/content/job`이 반환, 생성 완료 배너에 표시(`usageLine`). ⇒ 콘텐츠 생성은 토큰을 씀(구독제면 요금 아닌 사용량).
  - **카드 버튼 레이아웃**: 선택 버튼을 위 줄 전체 폭(라벨 2줄 "이 콘텐츠 선택 / → 상품 선택"), 수정·저장·모범·삭제를 아래 줄 균등. `.card-actions` flex-wrap.
  - 검증: 참고 CRUD·압축 payload(detail 제거/benefits)·model=sonnet job·다양성/참고 지침·버튼 2줄 레이아웃. (실시간 자동생성은 opus 기준 120s+로 느림 → 속도옵션 제공.)
- **2026-07-30 (예약 생성 스케줄러)**: 지정 시간(매주 요일/매일/한 번)에 콘텐츠를 **자동 생성 → "저장된 콘텐츠"로 수확**. `server.js`: `schedules.json`, `runScheduler`(setInterval 30s, `isDue`로 시각 매칭·같은 분 중복방지 `lastRun`), `createScheduledJob`(예약 params로 buildContentJob+scheduled 표시+dispatchToClaude), `harvestScheduledJobs`(완료된 scheduled job의 items를 saved-contents로 이동, dedupe). 엔드포인트 `GET/POST/DELETE /api/schedules`, `/api/schedules/toggle`, `/api/schedules/run`(즉시 실행). 프론트: 콘텐츠 탭 "⏰ 예약 생성" 패널 — 이름·반복·요일/날짜·시간 + [현재 설정으로 예약 추가](현재 생성폼 params 캡처), 목록에 on/off·지금실행·삭제. **프로그램(서버)이 켜져 있어야 실행**(AUTO_CLAUDE로 claude 자동 처리). 검증: isDue(매주월03:00 등)·추가/목록·run-now→32s후 saved 수확.
- **2026-07-30 ("Failed to fetch" 안정화 + 버튼 정렬)**:
  - **원인**: 스트림 파이프(`/api/thumb` 캐시·`/api/original`·CSV·업로드)에 error 핸들러가 없어, 스트림 에러 발생 시 Node 프로세스가 죽고 이후 모든 요청이 "Failed to fetch"가 됨(갤러리 썸네일 다량 로드 시 특히). 해결: `safePipe()`(error 핸들러 부착) + `process.on('uncaughtException'/'unhandledRejection')` 가드로 서버가 죽지 않게. 검증: 잘못된 업로드/썸네일 요청 후에도 서버 계속 200.
  - **버튼 정렬**: 이미지 컨트롤 줄 `.img-controls`(align-items:stretch, 컨트롤 height:38px 통일, NAS버튼 nowrap) + 카드 액션(Grid+height:100%)로 각 줄 버튼 세로 크기 동일·상하 정렬. 검증: 컨트롤 38px 균일, 카드 96px 균일.
- **2026-07-30 (주제별 개수·본문형 다중선택·NAS 직접찾기·UI)**:
  - **주제별 개수**(`cPerTopic`) + **본문 형 다중선택**(칩 `#formChips`, `selForms`) 추가. 서버 `buildContentJob(perTopic, forms)`: 총 count×perTopic개 생성, 형 배정 규칙(perTopic>forms → forms 각1회+나머지 랜덤 / forms>perTopic → forms 중 중복없이 랜덤 / 같으면 각1회 / 비면 자유). instructions에 명시. 검증: count2·perTopic3·forms2 job 정상.
  - **NAS 폴더 직접 찾기**: 이미지 찾기에 [📁 NAS 폴더 직접 찾기] → `#treePanel`(공유→폴더 드릴다운, 상위이동, "이 폴더 이미지 불러오기"). `/api/tree`·`/api/list-images`(기존) 사용. `app.js loadTree/treeUp/treeLoad`. 검증: 공유[RXC_V2,video]→웨스틴조선서울 222장 로드·선택.
  - **워딩**: "크롤링"→"상품 불러오기"(nav·heading·로그·에러문구). **UI**: 저장토글 색반전(`.btn.on`), 카드 버튼 = 선택 크게+수정/저장 작게 **동일 크기(Grid, `height:100%`로 높이 통일)**, 선택 콘텐츠 본문 말줄임표 제거, 본문형/화자 드롭다운→(형은 칩 다중선택으로 재변경).
- **2026-07-30 (판매 조건 "노출 상품 전체" 추가)**: `applyCondition`에 `all`(크롤링한 모든 상품·상태무관: 판매중+판매예정+매진) 추가. 드롭다운 "판매중 전체"→"판매중"(판매중만, 예정·매진 제외), "노출 상품 전체" 옵션 신설. 검증: 국내 all=1325(전체)·selling=1227(판매중). `server.js`·`index.html`.
- **2026-07-30 (본문 형·화자 드롭다운)**: 콘텐츠 생성의 `#cForm`(10가지 본문 형)·`#cPersona`(형별 화자, optgroup)를 text input → `<select>`로 변경(가이드 §3/§4 기준). value는 동일하게 job에 전달돼 JS 변경 불필요. index.html만 수정.
- **2026-07-30 (직접작성 매칭 · 상품 직접선택 · 이미지 업로드 · 콘텐츠 수정)**:
  - **내가 쓴 콘텐츠 → 상품 매칭**: 콘텐츠 생성 탭에 모드 토글(주제 자동생성 / 직접 작성). match 모드는 `POST /api/content/generate {mode:'match',userTitle,userBody}` → Claude가 본문 분석해 어울리는 상품·호텔·여행지 매칭(job.input.mode/userContent, 별도 instructions). `server.js buildContentJob(mode)`, `app.js submitGeneration/genModeTabs`.
  - **상품 직접 선택(피커)**: 콘텐츠 탭 "🧺 상품 직접 선택" — `GET /api/products/pick`(국내+해외 경량 목록) → 필터(구분/호텔·여행지/종류/검색) + 다중 체크(여러 호텔·여행지 교차 가능). 선택 시 생성/매칭이 그 productCodes 안에서만(`pickProducts`가 코드로 양쪽 데이터셋에서 필터). `app.js` `pickCodes`/`renderPicker`.
  - **이미지 업로드**: 이미지 찾기에 [⬆ 이미지 업로드]. `POST /api/upload`(base64 JSON) → `studio/uploads/`, 이미지객체 `{path:'upload:<id>',uploaded:true}`. `GET /api/uploads` 목록. `/api/thumb`·`/api/original`이 `upload:` 경로를 로컬 서빙(`serveUpload`). 갤러리는 업로드+NAS 병합(`allImages()`), 선택/다운로드/컨펌/미리보기/Claude추천 모두 지원(`/api/images/export`가 업로드 파일을 export 폴더로 복사해 추천 대상에 포함).
  - **제안 콘텐츠 텍스트 수정**: 콘텐츠/저장 카드에 [✏️ 수정] → 제목·본문·형·화자 인라인 편집(`editContentCard`). 콘텐츠 카드는 items 즉시 반영, 저장 카드는 기존 id 삭제 후 재저장(제목/본문 바뀌면 id 변경).
  - 검증: 선택상품 생성(2), match job(userContent), 업로드(썸네일 200)·갤러리 병합·선택, 피커 1415행·종류필터, 콘텐츠 수정 반영까지 JS/curl로 확인.
- **2026-07-30 (콘텐츠 개별 저장/즐겨찾기)**: 생성된 콘텐츠 카드마다 **⭐ 저장** 버튼 → `POST /api/saved`로 `studio/saved-contents.json`에 저장(제목+본문 sha1로 id, 중복 시 갱신). 콘텐츠 생성 탭 상단 "⭐ 저장된 콘텐츠 (N)" 토글 → 저장 목록 표시, 각 항목 **[이 콘텐츠 선택 → 상품 선택]**(재사용)·**[삭제]**. 엔드포인트 `GET/POST/DELETE /api/saved`. `app.js` `cardInner`(공용 카드 마크업)/`saveContent`/`renderSaved`/`refreshSaved`. 검증: 저장·목록·중복제거·삭제·재선택 확인.
- **2026-07-30 (해외 이미지 폴더 해석)**: 해외는 국내와 폴더 구조가 달라 **`studio/overseas.js`** 신설(도시 인덱스 캐시 `overseas-city-index.json`).
  - 구조: `00_콘텐츠/해외여행_<나라>/[지역별자료]/<도시>/{01_호텔,02_관광지,…}/*` → 도시 폴더 아래 전체 이미지. 지역별자료 없으면 나라 폴더 바로 아래가 도시(숫자접두 구조폴더 제외).
  - **해외패키지·현지투어**: `지역명`+`상품명` 토큰으로 도시 퍼지매칭(scoreMatch + 문자유사도로 `기타규슈↔기타큐슈` 흡수), 실패 시 나라 전체 폴백.
  - **해외호텔**: 상세 `기본정보`가 `[PKG 혜택]`(=카드 이모지 혜택)이면 **국내식**(`resolveHotelImageDir(지역명)`), 아니면(체크리스트/단독구성) 해외패키지식.
  - `server.js`: `/api/images?productCode=` 추가 → `findProduct`(code/id로 양쪽 데이터셋 조회) → `resolveProductImages`(유형별 분기). 응답 `mode`: domestic/overseas/overseas-country/overseas-hotel. `app.js`: 이미지 선택을 **타깃(대표 상품코드)** 기반(`imgTargets`)으로 변경, `loadImages`가 productCode로 호출·mode 배지 표시.
  - 검증: 나트랑/푸꾸옥/오키나와=도시매칭 600/600/305장, JW메리어트=overseas-hotel(호텔식) 212장, 국내=domestic 38장. 패키지·투어 70건 중 66건 폴더 매칭(나머지 4건 "보홀"은 NAS에 폴더 자체가 없음). image-picker HANDOFF에도 문서화.
- **2026-07-30 (상품ID/코드 정리 · 조건 · 미리보기 매칭 · 이미지 좌측패널)**:
  - **상품ID(숫자) vs 상품코드(영문) 분리**: `상품ID`=`goods.id`(숫자 5~6자리), `상품코드`=`goods.code`(URL). 크롤러 2종(`prizm_crawler.js`·`prizm_overseas_crawler.js`)이 둘 다 출력 + `판매시작일`/`판매종료일` 추가. `studio/crawl.js`에 `idOf`/`codeOf`/`saleFields`(alwaysOn) 추가. **국내 숫자ID는 캐시 데이터엔 없어 재크롤 필요**(해외는 상품id=99500 이미 있음). 가이드 2문서도 갱신.
  - **크롤링 테이블**: 상품ID + 상품코드 두 컬럼(할인율은 이전에 제거). [자세히] 팝업에 상품ID·코드 함께 표기.
  - **콘텐츠 생성 조건**(`cCondition`): 판매중 전체 / 상시판매만 / 특정일까지 판매(날짜) / 판매예정만. `server.js applyCondition`, buildContentJob이 조건 적용 후 products 전달. matched엔 productId+productCode 둘 다 복사(instructions 갱신).
  - **이미지 찾기 좌측 패널**(`#imgSide`): 선택 콘텐츠(제목·본문)+선택 상품 목록 표시. 패널을 `.img-layout`(좌 사이드 + 우 갤러리)로 재구성.
  - **미리보기**: ①이미지+상품 = **3:4 세로** 이미지 좌우 스와이프 캐러셀. ③이미지+상품 매칭 = 상품별 이미지 지정 셀렉트(`.match-editor`) + 매칭 슬라이드 스와이프. **상품코드/ID 표기 제거**(요청). 매칭은 `POST /api/content/matches`→`state.matches`(productCode→nasPath), `/api/preview`가 반환. `preview.js` 시그니처 `(root,content,images,products,matches,onChange)`.
  - 신규 엔드포인트: `GET /api/product?id=`(상세), `POST /api/content/products`, `POST /api/content/matches`. `state.json`에 `selectedProducts`,`matches` 추가.
  - 검증: 조건 always=1167·upcoming=48, 크롤 컬럼 상품ID+상품코드, 미리보기 3:4·매칭셀렉트·스와이프·코드미노출, 좌측패널, 매칭 저장까지 JS로 확인(브라우저 preview_start는 자동호출 런치설정 때문에 분류기 차단 → 임시 `AUTO_CLAUDE=0` 서버 + URL프리뷰로 검증).
- **2026-07-29 (초기 구축)**: studio 통합 웹앱 신설. 4단계(크롤/콘텐츠/이미지/미리보기) + 등록 자리. job 핸드셰이크(콘텐츠·이미지추천) 구현·검증.
- **2026-07-29**: 콘텐츠 카드에 **매칭 호텔/여행지 칩** + **상품 ID** 표기 추가(요청 반영). crawl.js `productIdOf`(URL goods 코드).
- **2026-07-29**: 콘텐츠 생성 방식 변경 — 주제를 직접 적지 않고 **주제 개수만 지정하면 데이터에서 그 개수만큼 자동 도출**(topic은 선택 힌트). 폼 라벨·job instructions·백엔드 수정.
- **2026-07-29**: 헤더 제목 앞 🏨 이모지 제거.
- **2026-07-29**: 본 HANDOFF 문서 신설(작업 완료 시마다 갱신).
- **2026-07-29 (상품 선택 단계 신설)**: ②콘텐츠 선택 후 ③**상품 선택** 단계 추가(단계 6개로 재번호). 콘텐츠의 추천(매칭) 상품을 체크박스로 다중 선택, 행마다 [자세히]→`GET /api/product?id=`로 상세 조회해 크롤링과 같은 팝업(국내 PKG 혜택/해외 기본정보·단독구성 + **투숙 기준/최대 인원**). 선택 결과는 `POST /api/content/products`→`state.selectedProducts`, 미리보기·이미지 단계가 이를 사용(미선택 시 전체). `crawl.js`에 `basePersons`/`maxPersons` 추가. 관련: `public/index.html`(panel3 재번호), `app.js`(setupProductStep/renderProductPick/fetchAndShowProduct/openProductModal 인원표시), `preview.js`(products 인자), `style.css`(.pick-list/.pick-row), `server.js`(/api/product, /api/content/products, preview products).
- **2026-07-29 (Claude 자동 호출)**: 콘텐츠/이미지추천 job을 [생성] 시 서버가 `claude -p --model opus --permission-mode acceptEdits` 로 **자동 실행**(문구 붙여넣기 불필요, 별도 프로세스=별도 채널, 구독 사용). `server.js` `dispatchToClaude`·`resolveClaudeBin`, `/api/content/generate`·`/api/images/export` 응답에 `auto` 플래그. 프론트는 auto면 "자동 처리 중" 배너, 지연 시(90s) 수동 문구로 폴백(`autoBanner`, pollContent/pollImageRec). 검증: `claude -p`가 pending job을 읽고 규칙대로 채워 done 저장 확인. (참고: hotels 배열을 자동런이 비워도 UI가 matched에서 파생 표시.)
- **2026-07-29 (크롤링 탭 개편)**: ①상품ID 컬럼 추가 ②할인율 컬럼 제거 ③해외 탭은 호텔/지역명 열 제거하고 상품구분으로 대체 ④행마다 [자세히] 팝업 — 국내=PKG 혜택(패키지 포함내역), 해외=기본 정보+단독 구성(crawl.js에 `baseInfo`,`exclusive` 분리 저장) ⑤지역·박수·상태 드롭다운 필터 + 가격 최소/최대 필터(국내·해외 공통). 관련: `crawl.js normalize`(overseas baseInfo/exclusive), `public/index.html`(.filters, #productModal), `public/app.js`(currentFiltered/renderProducts/openProductModal), `public/style.css`(.modal/.detail-btn).
