# 콘텐츠 이미지 추천기 — 작업 인수인계 (HANDOFF)

> 다른 Claude(또는 담당자)가 이 문서만 보고 작업을 이어갈 수 있도록 정리한 문서.
> 위치: `contents maker/image-picker/` · 무의존성 Node.js(내장 모듈만, `npm install` 불필요) · Node 18+.
> 최종 상태: **실제 NAS에 연결되어 전체 기능 동작 확인 완료.**

---

## 1. 이 프로그램이 뭔가

큐레이션 콘텐츠(주제·본문)에 어울리는 **실제 호텔 사진**을 회사 Synology NAS에서 빠르게 불러와
고르고 추천하는 **로컬 웹앱**. 상위 폴더 `contents maker/`의 콘텐츠 생성 프로젝트와 연계.

- 호텔 데이터: 상위 폴더 `prizm_all_YYYYMMDD.json`(291개 호텔) 재사용.
- 콘텐츠: 상위 폴더 `큐레이션_콘텐츠_*.md` 파싱해서 주제·본문·매칭호텔 자동 반영.
- NAS: `nas-in.rxc.co.kr:5000` Synology, FileStation API.

### ⛔ 절대 원칙: NAS는 읽기 전용
조회(list/search)·썸네일(Thumb)·다운로드(Download)만 한다. **파일 생성/삭제/이름변경/이동/업로드 등
어떤 쓰기·수정도 하지 않는다.** (`synology.js` 상단에 명시. 사용자가 강하게 요구한 원칙 — 반드시 유지.)
저장은 오직 이 PC의 `exports/`(추천용 썸네일)와 `.thumbcache/`(캐시)에만.

---

## 2. 실행 방법 (요약)

```bash
cd "contents maker/image-picker"
# 최초 1회: 설정
cp nas.config.example.json nas.config.json   # NAS user/password 입력 (2단계 인증 시 otp)
# 실행
node server.js                                # → http://localhost:8787
```
- 사용자는 이미 `nas.config.json`을 채워둔 상태(실서버 로그인 동작 확인됨). 비밀번호·API키는 사용자가 직접 입력.
- 포트 충돌 시: `PORT=8888 node server.js`.

**더블클릭 실행(터미널 불필요)**: `이미지 추천기.app`(서버 백그라운드 기동+브라우저 오픈), `종료.command`, `실행.command`(창 표시형).
`.app`은 프로젝트 경로가 하드코딩(`osacompile`로 생성한 AppleScript)이라 폴더 이동 시 재생성 필요. `.command`는 `$(dirname "$0")`로 상대경로라 이동 무관. 더블클릭 시 PATH가 최소라 node 경로(`/usr/local/bin` 등)를 스크립트가 직접 탐지함.

---

## 3. 파일 구조 & 역할

| 파일 | 역할 |
|---|---|
| `server.js` | HTTP 서버·라우팅, 썸네일 디스크 캐시/프록시. 설정 로드(nas.config.json / ai.config.json). |
| `synology.js` | **핵심.** FileStation 클라이언트(읽기 전용). 로그인/SID, 퍼지 폴더매칭, 저해상 폴더 해석, 재귀 이미지 수집, 썸네일/다운로드. |
| `content.js` | `prizm_all_*.json` 호텔목록 + 콘텐츠 md 파서(`## 주제` 블록 → 제목·본문·매칭호텔). |
| `exporter.js` | 후보 썸네일을 로컬 `exports/<라벨>/` 로 저장(+manifest.json, content.txt). 다중 호텔 지원. |
| `export.js` | CLI. `node export.js --hotel "..." [--theme] [--n] [--root] [--candidates]`. |
| `recommend.js` | (선택) API키 기반 Claude 비전 자동추천. 내장 fetch로 Anthropic Messages 호출. 기본 흐름 아님. |
| `public/index.html`,`app.js`,`style.css` | 프론트엔드 갤러리. |
| `nas.config.example.json`,`ai.config.example.json` | 설정 템플릿. |
| `hotel-folder-map.json` | 해석된 호텔→NAS경로 캐시(자동 생성). |
| `exports/`,`.thumbcache/` | 자동 생성. Git 대상 아님. |

### 서버 API 엔드포인트
- `GET /api/hotels` — 호텔 목록(+aiEnabled).
- `GET /api/contents[?file=]` — 콘텐츠 md 목록/파싱.
- `GET /api/images?hotel=[&fresh=1][&root=]` — 폴더 해석 + **재귀** 이미지목록(카테고리 폴더명 포함).
- `GET /api/candidates?hotel=` — "혹시 이 폴더?" 후보 목록.
- `GET /api/tree[?path=]` / `GET /api/list-images?path=` — 수동 폴더 드릴다운.
- `GET /api/thumb?path=&size=&mtime=` — 썸네일 프록시(+디스크 캐시).
- `GET /api/original?path=` — 원본 다운로드.
- `POST /api/export` — **Claude에게 보내기**: 후보 썸네일 로컬 저장. 단일`{hotel,paths}` / 다중`{label,hotels,items:[{path,hotel,folder}]}`.
- `POST /api/recommend` — (선택) API키 자동추천.

---

## 4. ⭐ 실제 NAS 구조 (반드시 숙지 — 탐색으로 알아낸 것)

공유폴더는 `RXC_V2`, `video` 두 개. **호텔 폴더는 깊이 3**에 있고, 그 아래 구조가 호텔마다 제각각:

```
/RXC_V2/업무협업문서함/00_콘텐츠/<호텔명>/01_포토&비디오/02_이미지/작업완료/{연도 고해상}/저해상_.../{카테고리}/*.jpg
```
- 호텔 루트 예: `00_콘텐츠/웨스틴조선서울`, `00_콘텐츠/제주신라호텔` (254개 호텔 폴더).
- **폴더명이 호텔명과 다름**: 공백 없이 붙거나(`웨스틴조선서울`), 접미사가 붙음(`그래비티 조선 서울 판교 오토그래프 컬렉션`).
- **`저해상` 위치·이름이 제각각**: `저해상_1280x720_300dpi`(웨스틴), `저용량_사용x`(제주신라, "사용x"=쓰지마 표시!), `드론 저해상`, 없는 경우도 있음.
- **파일명은 무의미**(`_MG_6172.jpg`, `DJI_0061.jpg`). **분류 정보는 카테고리 폴더명에 있음**(`001 디럭스`, `03_라운지앤바`, `로비`, `더파크뷰_조식`). → 키워드/추천은 반드시 **폴더명**을 활용.
- 같은 호텔명이 `03_브랜드쇼룸&SVG파일`에도 있음(로고/SVG). → 콘텐츠 폴더(`00_콘텐츠`) 우대, 쇼룸/디자인 감점으로 구분.

---

## 5. 핵심 로직 상세 (synology.js)

### (a) 호텔 → 폴더 퍼지 매칭 `collectRootCandidates(hotel)`
- 공유폴더부터 **BFS 깊이 3**까지 폴더명을 모아 `scoreMatch()`로 점수화·정렬.
- `scoreMatch`: 정규화 후 포함관계·핵심토큰 커버리지·최장공통부분문자열·bigram자카드의 **최댓값**. 군더더기 토큰(호텔/리조트/스테이 등) 제외.
- 부모폴더 보정: `00_콘텐츠` 등 우대(+0.06), 쇼룸/디자인/명함/백업 감점(-0.15).
- 실측: 실제 호텔들 매칭 1.00. 애매하면 `/api/candidates`로 "혹시 이 폴더?" 제시 + 수동 `root` 지정 가능.

### (b) 저해상 폴더 해석 `walkToImageDir(root)`
1. 고정 단계 매칭: `포토&비디오 → 이미지/포토 → 작업완료` (구체적 이름 우선, `02_비디오` 배제하는 순서 규칙 주의).
2. 그 아래에서 `_findLowResDir()`로 **저해상류 폴더 재귀 탐색**: `저해상/저용량/웹용/1280/…`. "사용x/미사용/원본/backup" 표시는 뒤로 미룸. **카테고리(하위폴더)가 2개 이상인 대표 저해상** 우선(드론만 있는 좁은 폴더 회피).
3. 대표 저해상이 없으면 → **앵커 폴더에서 전체 취합**(usedFallback=true). 그래도 이미지 없으면 이미지 최다 폴더로.

### (c) 재귀 이미지 수집 `listImagesRecursive(root)`
- 카테고리 폴더까지 BFS(깊이 3, 최대 600장). 각 이미지에 **`folder`(카테고리 폴더명)** 태그. cap으로 과다수집 방지.

### (d) 썸네일 — ⚠️ Synology `medium`은 BMP 버그
- `small`=정상 JPEG(~2KB, 갤러리용), `medium`=**BMP로 잘못 내려옴(사용 금지)**, `large`=정상 JPEG(~600KB).
- 갤러리=small, 라이트박스/원본=large/original, **export(Claude가 읽을 이미지)=large**.

---

## 6. "여기 Claude가 추천" 흐름 (핵심 기능, API키 불필요)

사용자가 **별도 결제(API키)를 원치 않아**, AI 추천을 프로그램이 아니라 **Claude Code 세션(우리)** 이 직접 하도록 설계:
1. 웹 UI "📁 Claude에게 보낼 폴더로 저장" → `/api/export` → 후보 썸네일(large JPEG)을 `exports/<라벨>/`에 저장 + `manifest.json`(로컬파일↔NAS경로↔호텔↔카테고리) + `content.txt`(주제·본문·호텔).
2. UI가 "이 폴더 사진들 중 '<주제>'에 어울리는 거 추천해줘" 문장을 제시 → 사용자가 Claude Code 채팅에 붙여넣음.
3. Claude가 `exports/<라벨>/`의 이미지를 **Read로 직접 보고** 추천. (large=JPEG라 Read 가능. 검증 완료.)
- CLI로도 가능: `node export.js --hotel "..." --theme "..."` → 폴더 경로 출력.
- **(선택) API 자동추천**: `ai.config.json`에 `apiKey` 넣으면 "✨ API로 자동 추천" 버튼 노출(`recommend.js`, 유료). 기본 흐름 아님.

---

## 7. 프론트엔드 흐름 (public/app.js)

- 입력 2탭: **호텔 직접 선택**(다중선택 `<select multiple>`, ⌘/Ctrl·Shift) / **콘텐츠 md 불러오기**(주제 선택 시 그 주제 매칭호텔 자동 → 큐레이션 로드).
- `currentHotels()`: md탭이면 주제의 매칭호텔(앞 20개), 아니면 셀렉트 선택값들.
- 다중 호텔: `loadImages()`가 호텔별로 `/api/images` 호출→이미지에 `hotel` 태그→합산. 타일에 호텔 배지.
- 키워드 필터(`matchesKeywords`)는 **파일명+카테고리 폴더명** 둘 다 매칭(파일명이 무의미하므로).
- 갤러리: IntersectionObserver 지연로딩, 타일 클릭=선택, 더블클릭=라이트박스.
- **선택 원본 다운로드**: `downloadSelected()`가 선택 이미지들의 `/api/original`을 순차 브라우저 다운로드(0.5s 간격).

---

## 8. 현재 동작 확인된 것 (실서버)
- ✅ 호텔 목록 291개, 콘텐츠 md 파싱(서울 43주제).
- ✅ 퍼지 매칭: 웨스틴/제주신라/그래비티 등 실제 폴더 1.00 매칭.
- ✅ 저해상 해석: 웨스틴 `저해상_1280x720_300dpi`(6카테고리 38장), 제주신라 전체취합(26카테고리 600장).
- ✅ 갤러리 썸네일 렌더링 + 카테고리 배지.
- ✅ Claude 추천용 export(large JPEG) → **Read로 실제 이미지 확인 성공**.
- ✅ 다중 호텔: 웨스틴+제주신라 = 638장, 호텔 배지, 콘솔 에러 없음.
- ✅ 다중 호텔 export(호텔+카테고리 태그 파일명).

---

## 9. 알려진 제약 / 주의사항
- **Synology medium 썸네일 = BMP 버그**. 절대 medium 쓰지 말 것(small/large만).
- 저해상 자동선택은 휴리스틱 — 폴더 구조가 특이하면 오선택 가능. → 단일 호텔이면 UI "직접 찾기"(트리 드릴다운) + "혹시 이 폴더?" 후보로 수동 보정. 다중 호텔 모드에선 수동보정 생략(1개만 선택하면 가능).
- md 주제 매칭호텔 중 NAS엔 있지만 prizm 목록엔 없는 곳(JW메리어트 등) 존재 가능. 반대도. 매칭호텔은 md 파싱 기준.
- 다중 호텔 대량(예 62개 호텔) 시 앞 20개만 로드(성능). 재귀수집 호텔당 최대 600장 cap.
- `hotel-folder-map.json` 캐시: 잘못 잡히면 `&fresh=1` 또는 수동 root로 갱신(수동선택은 캐시에 덮어씀).

---

## 10. 이어서 할 만한 작업 (아이디어)
- 저해상 자동선택 정확도 개선(카테고리 수 + 이미지 수 가중, 연도 최신 우선).
- 수동으로 고른 폴더(root)를 호텔별로 영구 저장/재사용 UI.
- 다중 호텔 대량 로드 시 호텔별 접기/펼치기, 호텔별 필터.
- export 시 원본(original)도 옵션으로 함께 저장.
- 키워드 사전 확장(실제 카테고리 폴더명 수집해 자동 보강).
- (원하면) 선택 이미지 원본을 zip 하나로 받는 서버측 zip(무의존성 store-zip 구현).

## 12. ⭐ 해외 상품 폴더 구조 (국내와 다름 — 2026-07-30 추가)

`synology.js`의 `resolveHotelImageDir`는 **국내 호텔용**(`00_콘텐츠/<호텔명>/…/저해상/…`). 해외는 구조가 달라, **해외 리졸버는 `../studio/overseas.js`** 에 구현했다(이 폴더의 synology.js를 재사용).

- **해외 폴더 구조**: `00_콘텐츠/해외여행_<나라>/[지역별자료]/<도시>/{01_호텔,02_관광지,…}/*`
  - 지역별자료 폴더명 제각각(`00_지역별자료`/`01_지역별자료`/`01_지역별 자료`) → "지역별" 포함으로 탐색. **없으면** 나라 폴더 바로 아래가 도시(단, 이때 `01_포토&비디오` 등 **숫자 접두 구조폴더는 도시 아님** → 제외).
  - 도시 폴더명에 숫자 접두 있기도(`1 나트랑`) 없기도(`기타큐슈`). 도시 폴더 **아래 전체 이미지**를 취합.
- **상품 3분류 → 폴더 규칙**:
  - **해외패키지·현지투어**: 위 나라/도시 구조. 상품의 `지역명`+`상품명` 토큰으로 도시 폴더 퍼지매칭(표기차 `기타규슈↔기타큐슈`는 문자유사도로 흡수). 도시 매칭 실패 시 **나라 전체** 폴백(도시국가 싱가포르/몽골 등).
  - **해외호텔**: 카드가 **이모지+혜택**(조식/클럽라운지…)형이면(=상세 `기본정보`가 `[PKG 혜택]`) **국내와 동일하게 호텔명(`지역명`)으로 `resolveHotelImageDir`**. 카드가 **체크리스트/단독구성**형이면 해외패키지와 동일한 나라/도시 구조.
- 도시 인덱스는 `studio/overseas-city-index.json`에 캐시(1회 스캔). 판별/해석은 `overseas.isHotelStyle(prod)` / `overseas.resolveOverseas(syno, prod)`.

## 11. 디버깅 팁
- 폴더 구조 탐색: `node -e "const {Synology}=require('./synology'); const s=new Synology(require('./nas.config.json')); s.list('<경로>',{onlyDirs:true}).then(r=>console.log(r.map(f=>f.name)))"`
- 매칭 점수 확인: `node export.js --hotel "..." --candidates`
- 전체 해석 확인: `resolveHotelImageDir(hotel,{useCache:false})` 결과의 `steps`.
- 문법: `node --check <file>`.
