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

- **2026-08-28 (노출 캘린더 → 별도 탭 + 국내/해외 구분 강화)**: 노출 캘린더를 ⑥ 등록 단계에서 빼내 **독립 탭**(nav "📅 노출 캘린더", `data-step="cal"`/`data-panel="cal"`, 위저드 스텝과 좌측 구분선). goStep에 `n=='cal'→loadCalendar()` 추가, renderPublishStep의 loadCalendar 제거. **국내/해외 구분을 세그먼트 버튼으로 강화**: 기존 발행도메인 select → `#calScopeSeg`(전체/국내(+공통)/해외(+공통)) 큰 세그(.seg-lg), wireCalendar가 버튼 클릭으로 calState.scope 토글. 나머지 캘린더 로직(하루/주/월·상태필터·요약·overlap 카운트)은 동일. 검증(8790): step6에 cal-wrap 없음·cal 탭/패널 존재·세그 3버튼, 탭 클릭 시 패널 활성+로드, 국내/해외 세그 전환 시 전체35·국내28·해외17 정상.

- **2026-08-28 (콘텐츠 본문 글자수 조정)**: 콘텐츠 생성 시 **본문 길이 선택** 추가. UI(index.html ② 생성 조건) `#cBodyLen` 프리셋 — 기본(100~300)·조금 길게(250~450)·길게(400~650)·아주 길게(600~900)·직접 입력(min~max). 직접 입력 시 `#cBodyLenCustom`(cBodyMin/cBodyMax) 노출. app.js `bodyLenValues()`가 commonBody에 `bodyMin/bodyMax` 주입(generate·brief 모드 공통, match는 사용자 본문이라 무관). server `buildContentJob(bodyMin,bodyMax)`: 20~2000 클램프·min<max 보정 후 `bodyRule=공백 포함 N~M자`로 지시문의 "본문 100~300자"를 동적 치환(생성 line5·brief line2), `rules.본문`도 per-job override, 300 초과 시 `bodyLenNote`(장면·디테일로 밀도 채우고 군더더기 금지) 추가. 기본값 100~300(기존과 동일). **가이드 md 갱신**(큐레이션_콘텐츠_제작가이드.md 본문규칙·체크리스트에 "글자수 조정 가능" 명시). 검증(8792): bodyMin/Max 600/900 → rules.본문·지시문·note 모두 600~900 반영, UI 프리셋/커스텀 토글·값(기본100-300·길게400-650·직접350-520) 정상.

- **2026-08-28 (⑥ 노출 캘린더 — 백오피스 게시글 전시기간 뷰)**: 등록 단계에 **노출중/노출예정 게시글을 캘린더로** 보는 기능 추가. 데이터는 스튜디오 큐가 아니라 **백오피스 실제 게시글**(스튜디오/백오피스 양쪽 등록분): API `POST manager-office-api-stage/manager/discover/post/search?page&size` (auth=세션 JWT를 **Bearer 없이 raw** authorization 헤더로). `office-posts.js`(세션 토큰 읽어 페이징 조회, discoverCategoryType DOMESTIC→domestic·INTERNATIONAL→overseas·**NONE→common(공통)** 매핑, displayStartDate/EndDate epoch ms·end null=무기한) + 엔드포인트 `GET /api/office/posts`(60초 캐시, force=1 갱신, 401→재로그인 안내). UI(index.html ⑥ 상단 `.cal-wrap` + app.js 캘린더 모듈 + style.css): **하루/일주일/한달** 뷰, **발행 도메인 필터 전체/국내(+공통)/해외(+공통)**, 상태 체크(노출중/노출예정/종료, now 기준 postStatus: start>now=예정·end<now=종료·그외=노출중, PUBLIC만 노출로 간주). 요약바(노출중/예정/종료 총계 + 오늘 노출 N건). 월=날짜셀에 그 날 겹치는(전시기간 overlap) 노출 건수+히트음영+시작 표시, 클릭 시 상세 리스트; 주=요일별 열에 그 날 노출 게시글 칩; 일=상세 리스트(오늘 시작/종료 수 포함). "3일 뒤 몇 건 노출중"은 해당 날짜 셀 카운트로 확인, "노출예정만" 체크 시 예정건만 남아 세팅 검증 용이. 검증(8790): 전체 노출중35, 국내(+공통)28·해외(+공통)17(공통10 중복), 월42셀·주7열·일상세·도메인/상태 필터·오늘클릭 상세(35건·시작1) 정상.

- **2026-08-28 (발행: 상품ID 미검색 → 상품명 폴백)**: **발행 실패 원인 규명**: 상품 조회 모달 '적용' 버튼이 disabled여서 click 타임아웃(30s)·재시도 57회. 근본원인 = **크롤 `상품id`(PRIZM 전시상품 id)가 백오피스 goods `상품ID`와 다른 상품이 존재**(호텔 객실 99050 등은 일치하지만, 패키지류 예: 페어몬트 "[10-12월] 클래식 스위트 킹 1박"(크롤 99762)은 백오피스에 상품ID 99762로 없음 → 실제 goods는 98228 "클래식 스위트 킹 (…PKG)"). 모달 검색조건은 **전체/상품ID/상품명 3가지뿐**(상품코드 없음), 상품명은 특수문자([],()) 있으면 검색 실패. **수정(publisher.js)**: `selectGoodsInModal(page,modal,g)` — ①상품ID 검색 후 결과행 있으면 체크, ②없으면 **상품명 폴백**: `searchFragment`(선두 [..]·"N박" 제거 후 괄호 앞 조각, 특수문자 회피)로 검색 → `matchRowByName`(행 전체텍스트 정규화 매칭, TEST/_copy 제외, 동률 모호 시 실패)로 정확 1건 선택. 상품명 칸이 td 가변위치(td[4])라 **행 전체 텍스트로 매칭**. 검색 실패 시 헬퍼 `searchInModal`이 "데이터가 없습니다"·체크박스 0 감지해 false. **미검색 상품이 하나라도 있으면 저장 안 함**(throw로 부분/오등록 방지, 미검색 상품ID·명 명시). `setSearchTypeToId`→`setSearchType(page,modal,typeName)` 일반화. 검증: 99762 폴백으로 98228 선택·적용 활성·실제 발행 성공(이미지4장+상품1개+저장완료 ✅), 실패였던 큐 항목(pub-mtcii1rl) published 처리. `module.exports`에 `__test` 노출(테스트용).

- **2026-08-27 (상품타입 칩 동적 카운트 + 0개 비활성 + 전체0 생성차단)**: 콘텐츠 생성 ②의 상품 타입 칩(해외 패키지/현지 투어/해외 호텔 등) count를 **현재 필터(구분+지역+판매조건+날짜)에 해당하는 실제 상품 수**로 동적 표시. server `typeCountsFor({scope,region,condition,until})`(pickProducts 재사용→타입별 count+total) + 엔드포인트 `GET /api/content/type-counts?scope=&region=&condition=&until=`. app.js `refreshTypeCounts()`가 구분·지역·판매조건·날짜 변경 및 init/지역목록갱신 시 호출→ `typeCounts`/`typeTotal` 저장. **0개 타입은 칩 비활성**(.chip.disabled: opacity.4·pointer-events none, 선택 자동 해제, 클릭 무시). **전체 0개(직접선택도 없음)면 콘텐츠 생성 차단**: `updateGenGate()`가 #genContent·#matchContent·#genBrief `disabled`, #genEmptyNote 안내 표시, submitGeneration에도 방어 가드(alert). 직접 상품선택(pickCodes)이 있으면 게이트 통과(체크박스/초기화 시 updateGenGate 호출). 미로딩(typeCounts=null) 상태에선 전역 count 표시·비활성 안 함. 검증(8791): 나트랑 selling=패키지6·투어7·호텔0(비활성), 방콕=호텔16, 일본=패키지7·투어8·호텔0, until 2026-09-15→투어7만·2026-12-31→total0(3칩 전부 비활성+생성버튼 disabled+안내), 국내 서울=프리미엄호텔53·라이프스타일8. UI 실측 genContent.disabled·note 노출 확인.

- **2026-08-27 (해외 지역 드롭다운 + 해외 지역필터 동작)**: 콘텐츠 생성 ②의 **지역**을 자유입력에서 **드롭다운**(`#cRegion` input→select)으로 변경, 선택 구분(국내/해외)에 존재하는 지역만 노출. ⚠️ 원본 크롤 데이터에는 **국가/도시 필드가 없음**(해외는 `지역명` 하나뿐, 예 "푸꾸옥 자유 패키지"·"그랜드 하얏트 에라완 방콕") → server `overseasRegion(r)`로 정규화: 패키지·현지투어는 지역명 첫 어절(도시), **해외 호텔**은 지역명이 호텔명이라 이름 속 도시 키워드(HOTEL_CITY: 하노이·방콕·다낭…) 추출(없으면 마지막 어절). `regionList(scope)`(도시별 count) + 엔드포인트 `GET /api/content/regions?scope=`. app.js `loadRegions()`가 init·구분변경 시 select 채움(없는 지역은 전체로 리셋). **버그 수정**: `pickProducts`의 지역필터가 `scope==='domestic'`에만 걸려 **해외는 지역필터가 무시**됐음 → 해외는 `overseasRegion(r)===region`으로 필터되게 수정. **일본 국가 그룹핑**(요청): `REGION_GROUP` 맵으로 일본 도시(오사카·기타규슈·대마도·이시가키·후쿠오카·삿포로·도쿄·교토·나고야·오키나와·일본)를 **"일본" 하나로 통합**(overseasRegion 말미 적용 → 목록·필터 자동 일관). 베트남 등은 도시 단위 유지. 검증(8791): 해외=괌9·나트랑16·대만2·몽골3·방콕16·**일본24**·코타키나발루7·푸꾸옥8·하노이4, 국내=강원·경기인천·경상·부산·서울·전라·제주·충청, 필터 나트랑→16·방콕→16(에라완호텔 포함)·일본→24(5개 지역명 통합). UI 드롭다운 전환·구분변경 재populate 확인.

- **2026-08-27 (custom 발행 자동세팅 + 실전 성공)**: **③ 이미지↔상품/쇼룸 매칭(custom) 자동발행 완성**. 발행 형태 라디오 `custom` 선택 시 publisher가 (1) 미디어 **OFF** 후 **Custom 라디오**(`input[type=radio][value="CUSTOM"]`) 체크, (2) 상품 추가 뒤 **행별 Description(14자, `input[placeholder*="14자"]`)** 입력, (3) **행별 이미지 첨부**. ⚠️ 백오피스 구조 실측: 행마다 file input이 있는 게 아니라 **페이지 공용 hidden `input[type=file]` 1개**뿐이고, **행의 첫 버튼(클립)을 클릭하면 그 행 대상으로 filechooser가 열리는 구조** → `Promise.all([page.waitForEvent('filechooser'), row.locator('button').first().click()])` 후 `chooser.setFiles(local)`로 첨부(행내 setInputFiles는 무동작). 미첨부 시 저장이 "Custom 모드에서는 모든 아이템에 미디어를 첨부해야 합니다"로 막힘 → 전 행 첨부 필수. server `runPublishJob`이 `mediaMode==='custom'`일 때 **customImages(productId→로컬경로)** 를 `matches`(key=productCode|productId|productName)→nasPath→staged.localPath로 구성해 `publishItem(it, staged, customImages)`에 전달. publisher 실패 시 `publish-staging/error-<id>.png` 스크린샷 저장(디버그용). 검증: 실 상품 2건(99050·99049)+로고 이미지 2장으로 stage 실등록 성공(설명 2·이미지 2·무기한·저장 완료 ✅). ※ UI엔 이미 custom 라디오 존재(index.html pubFormat), 별도 조작 불필요.

- **2026-08-26 (UI 심플화 + 미리보기 본문 8줄)**: 전반 디자인 정리 — 폰트 12종을 **5단계 위계 토큰**(--fs-title/heading/body/desc/meta)으로 통일, 장식 이모지 **64개 제거**(기능기호 x/check만 유지), 설명글 볼드 제거(.muted b 굵기 400), 여백 리듬(같은 영역 타이트·다른 영역 --sp-4로 분리), 카드 그림자 제거(플랫). style.css에 토큰+정리 블록 추가. **미리보기 본문 3줄→8줄**: preview.js가 본문 전체를 넣고 CSS -webkit-line-clamp:8로 클램프, draw()가 scrollHeight>clientHeight일 때만 더보기 노출(초과 안 하면 전체 표시). 헤더 "화자 · 호텔 외 N개", 밝은 배경 유지(검은색 아님). 검증: 20줄→8줄 클램프(166px)+더보기 조건 true, 실제 미리보기 렌더·콘솔 에러 없음. ※ CSS 수정 후엔 브라우저 새로고침 필요(캐시).

- **2026-08-26 (② 콘텐츠 생성 UI 영역 구분 + 생성버튼 별도 행)**: 콘텐츠 생성 패널을 2개 카드로 명확히 구분 — **🧺 대상 상품 범위**(구분·지역·판매조건·상품타입 칩·상품 직접선택)와 **✍️ 콘텐츠 생성 조건**(주제개수·주제별·속도·주제방향·프리셋·본문형·화자). `콘텐츠 생성` 버튼을 화자 행에서 빼내 **별도 행(.gen-actions, 우측정렬, .btn.lg 200×51 "✨ 콘텐츠 생성")**로. index.html에 `.gen-group`/`.gen-group-h`/`.gen-actions` 래핑, style.css 추가. 검증: 2그룹·picker/typeChips 그룹1·화자 그룹2·버튼 그룹밖 별도행, 콘솔 에러 없음.

- **2026-08-26 (상품 타입 칩 국내/해외 필터)**: 콘텐츠 생성의 상품 타입 칩을 선택 구분(#cScope)에 맞춰 필터. server `productTypeList()`가 타입별 `source`(domestic/overseas/both) 반환(크롤 출처=국내 호텔유형/해외 상품구분 기준). app.js `renderTypeChips()`가 scope에 맞는 타입만 노출(both는 항상), 구분 변경 시 재필터+타 구분 선택 해제. 검증: 국내=프리미엄 호텔·라이프스타일·프리미엄 리조트·프리미엄 스테이·풀빌라·스테이·프리미엄 레지던스·캠핑·한옥 풀빌라·캠핑 풀빌라(10), 해외=해외 패키지·현지 투어·해외 호텔(3), 전환 즉시 반영, 콘솔 에러 없음.

- **2026-08-26 (자동발행 실전 성공 + 셀렉터 수정 + 전시종료일 자동세팅 + 이식성 검증)**: **Playwright 자동발행 end-to-end 실전 성공**(status=published, stage 실등록). 로그인 세션 실측: 백오피스 인증은 **localStorage JWT**(쿠키 아님) — `office-session.json` storageState(origins.localStorage.token)로 재사용됨. **publisher.js 셀렉터 2건 수정**(첫 실행에서 발견): (1) `상품 조회` 버튼이 사이드바 "상품 조회/관리"와 겹침 → `getByRole('button',{name:'상품 조회',exact:true})`. (2) 상품조회 모달 검색값 input이 MUI Select 숨은 input과 혼동돼 fill timeout → `modal.getByRole('textbox').first()`(role=textbox), 검색조건은 `div[role=combobox]`가 아니라 `getByRole('button',{name:'searchType'})`→옵션 '상품ID'. **이식성(jayce) 검증**: git이 코드(package.json·publisher/login/_officecfg)는 포함, 개인/기기별(office-session.json·node_modules·publish-staging·publish-queue)은 제외 → jayce는 pull+`npm i playwright && npx playwright install chromium`+`node publish-login.js`(본인 백오피스 계정)로 사용. Playwright 미설치자도 앱 전체 정상(발행만 안내). README_배포.md에 "⑥ 자동 발행 설정" 섹션 추가. **전시 종료일 자동 기본값**(신규): `buildPublishDraft`가 선택 상품(쇼룸 제외)의 크롤 `saleEnd` 중 최댓값을 `displayPeriod.end`(YYYY-MM-DDT23:59)로, **상시판매(alwaysOn) 포함 시 무기한**으로 자동세팅(수정 가능). `crawlSaleIndex()` 추가. 검증: 99272(상시)→무기한, 날짜상품→최장일.

- **2026-08-25 (완전 자동 발행 = Playwright 헤드리스, "버튼만 누르면 등록")**: Claude 개입 없이 **스튜디오 서버가 직접 헤드리스 크롬(Playwright)으로 백오피스에 등록**. 신규: `_officecfg.js`(baseUrl·sessionFile·headless, studio.config.json의 office 섹션), `publish-login.js`(최초1회 실브라우저 로그인→세션 `office-session.json` 저장, 비번 저장 안 함), `publisher.js`(`publishItem(item,stagedFiles)` — 세션재사용 headless로 도메인 radio/발행주체 자동완성/제목·내용/미디어토글+`setInputFiles`(스테이징 업로드)/상품조회 모달(검색조건 상품ID→ID검색→체크→적용)/전시기간 무기한·종료/저장→"게시글이 등록되었습니다" 대기). server.js: `stageImagesFor(it)` 추출, `runPublishJob(id)`(백그라운드 stage+publish→status 갱신), **`/api/publish/run`이 이제 `status=publishing` 후 headless 발행 실행**(대기+채팅 방식 폐기), `/api/publish/office-status`(playwrightOk·sessionOk). app.js: `runPublish`가 office-status 점검(미설치/미로그인 안내)→확인→run→`pollPublishStatus`(publishing→published/failed 폴링), PUB_STATUS에 `publishing`. 의존성: `studio/package.json`+`playwright`(각 PC `npm i playwright && npx playwright install chromium`), gitignore: `office-session.json`·`node_modules`·`publish-staging/`. 검증(8791): office-status(pw✓/session✗), run→publishing→failed(세션없음 안내). **실전 테스트 남음**: 사용자가 `node publish-login.js`로 세션 저장 후 [발행 실행] → 실제 headless 등록. publisher.js 셀렉터(발행주체 정확일치·상품조회 MUI select·무기한 체크박스·미디어토글)는 첫 실행 후 튜닝 필요할 수 있음. custom(B-3)은 백오피스 매칭 UI 생기면 추가. **stage→prod: `_officecfg` baseUrl만 교체.**

- **2026-08-25 (B-3 조사 — 백오피스에 custom 매칭 UI 부재 확인)**: custom(이미지↔상품 매칭, 미리보기3) 자동화를 위해 stage create 폼을 실측했으나, **미디어 ON 상태에 Normal/Custom·이미지↔상품 매칭 UI가 없음**(이미지 목록 + 상품표가 각각 별도, get_page_text로 확정). Normal/Custom 라디오는 **미디어 OFF**일 때 상품/쇼룸/콘텐츠/숏품 4탭과 함께 나타나며, OFF엔 이미지가 없어 이미지 매칭이 아님. → **결론: 이 stage 빌드엔 custom 이미지↔상품 매칭 기능이 아직 없음**(사용자 "stage엔 테스트 기능만"과 부합). **B-3 보류**: 백오피스에 custom 매칭 기능이 배포되면 그때 자동화(스튜디오는 이미 `matches`·`mediaMode:custom` 보유). 사용자 확인 필요: custom 매칭 화면이 stage 다른 곳에 있는지/미배포인지.

- **2026-08-25 (B-2 완료 — 이미지 포함 게시물 완전 자동발행 검증)**: **미디어 normal(이미지+상품) 자동 저장 end-to-end 성공.** Claude in Chrome 확장 연결(`list_connected_browsers`) 후: (1) `stage-images`로 NAS 2장 로컬 스테이징 → (2) create 폼에서 `mcp__claude-in-chrome__file_upload(ref=파일input, paths=[스테이징 로컬경로])`로 **이미지 2장 실제 업로드 성공**(미디어 영역에 썸네일 표시) → (3) 국내 radio·발행주체 체크인(자동완성)·제목·무기한(체크박스 클릭)·저장 → **"게시글이 등록되었습니다"**. **중요**: claude-in-chrome `read_page`는 파일input(type=file)·무기한 체크박스 등 **모든 요소를 깔끔한 ref로 노출**(in-app 브라우저보다 훨씬 안정적) → 앞으로 발행 자동화는 **claude-in-chrome 사용 권장**. file_upload는 1콜 합계 <10MB, 세션이 읽을 수 있는 로컬 경로(작업디렉토리 등)만. **최종 발행 런북(미디어 ON)**: [발행 실행]→status requested→"발행 실행 처리해줘"→Claude가 `POST /api/publish/stage-images`→claude-in-chrome로 create 폼 채우기(도메인·발행주체·제목/내용·아이템 상품ID조회/쇼룸검색·필터키워드·전시순서·전시기간 무기한)+file_upload(staged)+(custom 이미지매칭)+저장→`POST /api/publish/status published`. 미디어 OFF는 이미지 단계 생략. **남은 것**: custom(이미지↔상품 매칭) 자동화, 트리거→자동실행 매끄럽게(현재는 채팅 "발행 실행 처리해줘" 수동 트리거). ※ 전제: 확장 연결·사용자 Chrome이 stage 로그인.

- **2026-08-25 (B-2 착수 — 이미지 자동발행: 서버 스테이징 완료)**: 미디어 ON(이미지) 게시물 완전 자동발행을 위한 1축인 **로컬 이미지 스테이징** 구현·검증. `POST /api/publish/stage-images {id}` → 발행 항목의 `images[]`(NAS `nasPath` 또는 `upload:<id>`)를 `publish-staging/<id>/`로 다운로드(`syno.download`/uploads 재사용, `NN_이름.ext`), `{dir,count,files:[{nasPath,name,localPath}]}` 반환. 검증(8791): 함덕비치스테이 NAS 이미지 2장(3.2MB+4.1MB) 로컬 저장 확인. gitignore: `publish-staging/`. **남은 축(파일 업로드 자동화)**: `mcp__claude-in-chrome__file_upload`(로컬 경로→파일 input)로 백오피스 "+" 업로드 → 하지만 **Claude in Chrome 확장 미연결**(`list_connected_browsers`=[])이라 대기. **완료 시 런북**: [발행 실행](미디어 ON) → stage-images → Claude in Chrome으로 폼 채우기+file_upload(staged)+(custom 매칭)+저장. **전제**: 확장 설치·사이드패널 로그인·사용자 Chrome이 stage 로그인. 참고: 미디어 OFF는 이미 완전 자동.

- **2026-08-25 (개선 2건 — 노출종류별 표시 · 이미지선택 유지)**: (1) **등록 편집기 노출종류 정렬**: `it.exposure`로 상품 노출이면 아이템 표에 **상품명만**(고정), 쇼룸 노출이면 **쇼룸명만**(수정 가능). 라벨 "아이템 (상품/쇼룸)", "구분/쇼룸명" 컬럼 제거, +버튼은 쇼룸 노출에서만("+ 쇼룸 추가"). `renderPubEditor`/`pubItemRow(x,i,isCustom,isShowroom)`. (2) **이미지 선택 유지**: `loadImages`·treeLoad의 `selectedTiles.clear()` 제거(폴더/호텔 전환에도 선택 유지), `setupImageStep` 진입 시에만 clear. `renderGallery`가 `renderSelectedStrip()` 호출 → 갤러리 위 **"🖼 선택한 이미지(N)" 스트립**(썸네일·개별✕·전체해제)으로 유저가 전체 선택현황 확인/해제. index.html `#selectedStrip`, style.css `.selected-strip`. 검증(8791): 상품→상품명만/쇼룸→쇼룸명만, 타일 2선택 후 다른 호텔 전환해도 selectedTiles 2 유지+스트립 표시, 콘솔 에러 없음.

- **2026-08-25 (⑥ 발행 Phase 2 step1 — [발행 실행] 트리거 연결)**: 발행 큐 항목을 실제 등록하는 트리거를 연결. **동작**: 편집기 [발행 실행] → 저장 + 검증(제목/내용·발행주체·전시기간·아이템 필수) + 확인 → `POST /api/publish/run`(status='requested') → 안내 "채팅에 「발행 실행 처리해줘」 입력". 실제 폼 자동입력·저장은 **이 세션 Claude가 in-app 브라우저**로 수행(헤드리스 `claude -p`엔 브라우저 없음 → 자동 dispatch 불가, 대화형 세션 전용). 완료 시 `POST /api/publish/status {id,status:'published',postId}`. 큐 목록에 상태 배지(초안/🕒발행대기/✅발행됨/⚠실패). 신규 엔드포인트 `/api/publish/run`·`/api/publish/status`·`/api/publish/showroom-map`(gitignore: publish-queue.json·showroom-map.json). 검증(8791): run→requested, status→published+postId 23, 쇼룸맵 저장 확인.
  - **쇼룸 자동 맵핑 방식(주기 스캔 대신 "실시간+예외학습")**: 발행 시 각 쇼룸 아이템을 백오피스 쇼룸검색으로 **크롤명 라이브 조회** → (a)정확·단일 매칭이면 자동선택(신규 쇼룸도 라이브라 자동 반영) (b)무매칭/모호면 사용자에게 후보 선택 요청 → 그 매핑을 `showroom-map.json`(크롤명→쇼룸ID/명)에 **예외만 캐시**. 다음부터 같은 크롤명은 캐시 사용. 전체 목록 주기수집 불필요·항상 최신·예외만 학습.
  - **발행 자동화 런북(Claude가 "발행 실행 처리해줘" 시 수행)**: 1) `GET /api/publish/queue`에서 status='requested' 항목. 2) 로그인된 stage 탭에서 create 페이지 이동. 3) 항목 채우기 — 발행도메인 radio(domain) / 발행주체 쇼룸검색+정확선택(publisherShowroom) / 제목·내용 / 미디어(off→OFF, normal·custom→ON+이미지업로드) / 아이템[goods: 상품탭·Normal|Custom·상품조회→검색조건 상품ID→각 productId 검색·체크·적용 / showroom: 쇼룸탭·쇼룸선택→showroomName 검색·정확선택(무매칭 시 showroom-map 확인→없으면 사용자 선택 후 map 저장)] / (custom)아이템별 description·이미지 매칭 / 필터키워드(선택, 신규는 톱니 등록) / 전시순서·노출여부 / 전시기간(start·end·무기한). 4) [저장]→"완료" 확인. 5) 목록에서 새 게시글ID 확인 → `POST /api/publish/status`로 published 기록. 6) 사용자에 보고. ※ 실제 검증: 상품 노출 1건(게시글ID 22) 저장 성공.

- **2026-08-25 (쇼룸 노출 매칭 검증 — 백오피스 쇼룸 실측)**: create 폼 **아이템 쇼룸 탭**의 "쇼룸 선택" 검색(부분일치, 쇼룸ID+쇼룸명+브랜드명 반환)으로 크롤 명칭↔백오피스 쇼룸명 대조. **결과**: 해외=지역명 정확 일치(나트랑=22302 나트랑; "나트랑 자유 패키지"는 고객페이지 타이틀일 뿐), 국내=대부분 일치(웨스틴 조선 서울=21353 ✓)하나 **롯데 계열 등 명칭 불일치 존재**(크롤 "더그랜드롯데 서울"↔백오피스 "롯데호텔서울"; "더그랜드롯데" 검색 시 No options). **발행주체 쇼룸(체크인/인트립)과 아이템 쇼룸은 별개 목록**(개별 호텔은 발행주체 검색엔 없음). **결론/Phase2 방침**: 상품 노출=상품ID로 넣으면 쇼룸 자동연결이라 robust. 쇼룸 노출=발행 시 백오피스 쇼룸 검색으로 크롤명 조회→ **정확·단일 매칭이면 자동선택, 무매칭/모호하면 사용자에게 선택 요청**(가능하면 백오피스 쇼룸ID 확보). ③단계 "정확" 배지는 크롤 데이터 확인일 뿐 백오피스 매칭 보장이 아니므로 문구 완화 필요. (선택 개선: 백오피스 쇼룸목록을 1회 수집해 크롤명→쇼룸ID 매핑 테이블 구축.)

- **2026-08-25 (⑥ 발행 Phase 2 — 실제 등록 end-to-end 성공)**: in-app 브라우저로 create 폼을 처음부터 끝까지 자동 입력 → **[저장] 실행 → stage에 게시글 실제 등록 성공(게시글 ID 22, 국내·쇼룸 체크인·"라세느냐 아리아냐"·무기한·공개)**. "완료: 게시글이 등록되었습니다" 확인, 목록 최상단 반영 확인. **검증된 상품조회 흐름**: [상품 조회] 모달 → 검색조건 드롭다운=**상품ID** → 값 입력 → [검색] → 결과 체크박스 → [적용] → 아이템 테이블에 행 추가(상품ID·상품명·브랜드명·쇼룸명·전시/판매일·상태). **중요 발견(쇼룸명 불일치)**: 상품 99050의 백오피스 쇼룸명은 "롯데호텔 서울_객실"인데 우리 크롤 호텔명은 "더그랜드롯데 서울" → 상품 노출은 상품ID로 넣으면 쇼룸 자동연결이라 무관하지만, **쇼룸 노출 모드는 백오피스 쇼룸 검색에서 정확 매칭 확인 필요**(크롤 호텔명↔백오피스 쇼룸명이 다를 수 있음). **다음**: (a) 프로그램 [발행 실행]→큐 항목을 Claude에 넘기는 트리거 연결, (b) 항목 데이터 기반 자동화 루틴화(상품/쇼룸/Normal·Custom/미디어 이미지업로드+매칭/description/필터키워드 톱니/전시순서), (c) 쇼룸 노출 정확 매칭 검증. ※ 등록된 테스트글(ID 22 등)은 stage 데이터.

- **2026-08-25 (⑥ 발행 Phase 2 착수 — 라이브 폼 자동화 실증)**: in-app 브라우저(로그인된 stage 탭)로 create 폼 자동 입력을 **실측 검증**. 성공 확인: 발행도메인 radio(국내), 발행주체 쇼룸검색 타이핑→자동완성 정확 선택(체크인 21293, 칩 표시), 제목, 내용(textarea), 미디어 ON/OFF 토글. **저장은 미실행(실데이터 방지)**. **추가 발견**: 아이템 탭은 미디어 OFF 시 4종(상품/쇼룸/**콘텐츠/숏품**), ON 시 상품·쇼룸만 / **Normal·Custom 라디오**는 아이템 영역(상품조회 위)에 위치 / **상품 조회 = 모달**(검색조건 드롭다운+값[상품ID 검색 가능]·상품상태·입점사·브랜드 필터→선택→[적용]). **트리거 설계(예정)**: 프로그램 [발행 실행] → 큐 항목을 넘김(파일 핸드셰이크 or 채팅) → Claude가 in-app 브라우저로 폼 채움 → 화면 확인 후 [저장]. 첫 실전 저장은 사용자 승인. **남은 자동화**: 아이템(상품ID 조회·선택 / 쇼룸 검색·선택 / Normal·Custom) · 미디어 이미지 업로드+custom 매칭 · custom description 입력 · 필터키워드 선택/톱니 신규등록 · 전시순서 · 전시기간 · 최종 저장.

- **2026-08-25 (③ 아이템 선택 = 상품/쇼룸 노출 선택)**: 최종 게시물이 상품 노출 OR 쇼룸 노출 중 하나이므로, 콘텐츠 선택 후 **노출 종류(상품/쇼룸)를 먼저 고르고** 해당 아이템 선택. ③단계를 "아이템 선택(상품/쇼룸)"으로 개편 — 상단 노출종류 라디오(`expoType` goods/showroom), 상품 피커 + **쇼룸 피커** 분기. **쇼룸=정확 명칭**(등록 오류 방지 핵심): 서버 `resolveShowrooms(matched)`가 콘텐츠 매칭 상품의 productCode/ID를 크롤 데이터셋과 대조해 **국내=정확 호텔명(예 비스타 워커힐 서울)·해외=지역명**을 도출(데이터에 있으면 `exact:true` "정확" 배지, 없으면 매칭텍스트 폴백+"확인필요"). 엔드포인트 `GET /api/content/showrooms`, `POST /api/content/exposure`(exposureType+products/showrooms 저장), state에 `exposureType`·`selectedShowrooms`. 하류 연동: ④이미지=쇼룸이면 쇼룸명+대표 productCode로 이미지 해석 재사용, ⑤미리보기·⑥발행초안(`buildPublishDraft`)이 exposure=showroom이면 `kind:'showroom'` 아이템 생성. app.js: `loadShowroomCandidates`/`showroomCands`/`setExposure`/`renderShowroomPick`(정확 배지)/setupProductStep async화. **검증(8791)**: 국내 콘텐츠→쇼룸 4개 exact=true(더그랜드롯데 서울 등), 선택→확정→④"선택 쇼룸(2)"→⑥초안 exposure=showroom items 쇼룸, 상품모드 회귀 정상, 콘솔 에러 없음. **주의(Phase 2)**: 쇼룸 크롤에 showroom ID가 없어 이름 기반 매칭 — 더 정확히 하려면 크롤러가 sr.id 수집하도록 개선 검토.

- **2026-08-25 (⑥ 등록/발행 기능 Phase 1 — 발행 설정 단계·발행 큐)**: stage 백오피스(`manager-office-stage.prizm.co.kr/display/discover/post/create`)에 게시글을 등록하는 기능. **방식**: 프로그램이 발행 설정을 다 잡아 "발행 큐"에 쌓고 → (Phase 2) in-app 브라우저가 create 폼을 자동으로 채우고 **[저장]까지** 실행(사람은 프로그램에서 [발행 실행] 클릭으로 승인). API 직접호출 대신 브라우저 자동화(React SPA·프론트검증·파일업로드 때문). stage→prod는 주소만 교체.
  - **확인된 create 폼 구조**(로그인 후 실측): 발행도메인(공통/국내/해외 radio) · 발행주체(쇼룸/프로필/리뷰 tab + 쇼룸검색 자동완성, 쇼룸=ID+명 예 `21293 체크인`) · 제목(≤24) · 내용 · 미디어(ON/OFF + "+"업로드, jpg/png/mp4 16:9·9:16) · 아이템(상품/쇼룸 tab + 상품조회 + 전시순서변경 + 표[상품ID·상품명·브랜드명·쇼룸명·전시시작·판매시작/종료·상태]) · 필터키워드(검색 + 톱니 신규등록) · 전시순서(숫자+노출토글) · 전시기간(datetime 시작~종료 + 무기한, 필수).
  - **미디어 모드 = 미리보기 선택**: 미리보기②→미디어 OFF(상품만) / ①→ON normal / ③→ON custom.
  - **Phase 1 구현(완료)**: server.js — `publish-queue.json`(gitignore) + `buildPublishDraft`(현재 콘텐츠·상품·이미지·분류로 초안, 도메인 자동추천·발행주체 체크인/인트립 자동) + `buildPublishDescJob`(custom description ≤14자 자동생성 job) + 엔드포인트 `/api/publish/format`·`/api/publish/draft`·`/api/publish/queue`(GET/POST/DELETE)·`/api/publish/description`(+폴링). index.html — ⑤미리보기에 발행형태 라디오+[대기목록 추가], ⑥등록에 발행 큐(목록+편집기). app.js — `renderPublishStep`/큐 CRUD/편집폼(도메인·발행주체·제목24·내용·아이템 상품+쇼룸추가·custom설명 자동생성·필터키워드 신규표시·전시순서·전시기간 검증)/`genDescriptions`. style.css — 발행 UI. **검증(8791)**: 초안 items4·domain domestic·media normal, 큐추가→편집폼 전필드 렌더(발행주체 체크인 자동, 쇼룸명 호텔명 자동), 콘솔 에러 없음.
  - **남은 것(Phase 2)**: in-app 브라우저 자동화 — 발행 큐 항목 선택 → create 폼 자동 입력(발행도메인 radio, 발행주체 쇼룸검색 타이핑+선택, 제목/내용, 미디어 on/off, 이미지 업로드, 아이템 상품ID조회·쇼룸검색, custom description, 필터키워드 선택/톱니등록, 전시순서, 전시기간) → **[저장] 실행**. `normal/custom` 세부(이미지 추가 후 UI)는 실제 이미지 업로드하며 확정. 쇼룸명↔백오피스 쇼룸 매칭(검색결과 다건 시 선택) 로직 필요.

- **2026-08-25 (코퍼스 저장소 개인계정 이전)**: 협업자 관리 일원화를 위해 모범 코퍼스를 `rxcompany/prizm-curation-editor` → **`Mark-ji-rxc/prizm-curation-editor`**(개인·Private)로 이전. 로컬 remote set-url 후 모범 16편 push, README_배포.md·setup.command의 `CURATION_URL`도 개인주소로 교정 후 코드repo에 재push. 이제 **코드·코퍼스 둘 다 Mark-ji-rxc 소유** → 협업자 초대·권한을 한 계정에서 처리. (studio.config.json의 referenceRepoDir는 로컬 클론 경로라 변경 불필요.)

- **2026-08-25 (배포 Phase 2 — GitHub 업로드 완료)**: **코드 저장소 = `https://github.com/Mark-ji-rxc/prizm-curation-contents`** (회사 org 접근 불가로 개인 계정에 생성, Private). 초기 커밋 push 완료(비밀 `ai.config.json`·`exports/`·`.app` 제외 확인). **모범 코퍼스 저장소 = `https://github.com/rxcompany/prizm-curation-editor`** (접근 가능 확인 → 이동 불필요, 로컬 모범 16편 push 완료). README_배포.md 코드 clone 주소를 개인 저장소로 교정(코퍼스 주소는 유지) 후 재push. 인증: 개인 PAT(Classic `repo` scope) + osxkeychain 캐시. **남은 것**: (a) 다른 사용자에게 두 저장소 접근권 부여 — 코드=개인repo 협업자 추가, 코퍼스=rxcompany org 멤버/협업자, (b) 각 PC git 자격증명 설정(서버 startup gitPull 프롬프트 방지), (c) 커밋 identity(현재 mark@local 자동값) 정리는 선택.

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
