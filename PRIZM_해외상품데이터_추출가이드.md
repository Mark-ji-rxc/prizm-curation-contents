# PRIZM 해외 상품 데이터 추출 가이드

PRIZM 모바일웹(`https://mweb.prizm.co.kr`)의 **해외 여행상품(해외패키지·해외호텔·현지투어)** 데이터를 긁어와
CSV/JSON 으로 정리하는 방법. 국내 호텔 크롤러(`PRIZM_상품데이터_추출가이드.md` / `prizm_crawler.js`)의 해외 버전이다.

> 마지막 검증: 2026-07-29 / **해외패키지 47 · 해외호텔 22 · 현지투어 21 = 총 90개 상품** 추출 완료
> 실행 도구: 같은 폴더의 `prizm_overseas_crawler.js` — `node prizm_overseas_crawler.js`
> 산출물: `검색결과/prizm_해외_통합_YYYYMMDD.csv`, `검색결과/prizm_해외_all_YYYYMMDD.json`
>
> **변경 이력**
> - 2026-07-30: **상품id/상품코드 구분 명확화 + 판매일자 컬럼 추가**. `상품id` = `goods.id`(숫자 5~6자리, 내부 식별자·상세 API/등록 매칭용 — 예: `99500`). `상품코드` = `goods.code`(영문, 상품 URL `/goods/{code}`). 기존엔 코드가 URL 컬럼에만 있었으나 이제 **`상품코드` 컬럼을 별도 출력**한다. 또 `판매시작일`·`판매종료일`(ISO yyyy-mm-dd, 기간 없으면 빈 값) 컬럼 추가.

---

## 0. 핵심 요약 (TL;DR)

- 접근 방식은 국내와 동일: **SPA라 페이지 fetch로는 안 나오고, 내부 REST API(`api.prizm.co.kr`)를 직접 호출**한다.
- 필수 헤더 `X-PRIZM-CHANNEL: MWEB` (없으면 400). 비로그인 토큰은 빈 값. 브라우저 불필요.
- **국내와 다른 점(중요):**
  1. 해외 목록 응답은 `showRoom` 이 **null**, `showRoomId` 가 **0** → 상세 API는 `/v1/goods/{id}/showroom/0` 으로 호출.
  2. 지역/브랜드 그룹명은 `content[].title` (예: `푸꾸옥 인터컨티넨탈`, `오키나와 자유 패키지`, `일본 현지투어·티켓`).
  3. **"기본 정보 / 단독 구성"이 두 가지 구조로 내려온다** (아래 4번). 둘 다 파싱해야 데이터·플래그가 안 샌다.
- 🚨 **페이지네이션 필수**: 목록 API는 브랜드 8개 단위. 응답 `nextParameter`(예: `offset=8`)를 끝까지 따라가야 한다.
  (해외패키지는 19개 브랜드/47상품 → 첫 페이지만 보면 대량 누락)

---

## 1. 상품구분 → categoryId 매핑

`/?region=international` 에서 상단 탭을 누르면 `/section/category/{categoryId}` 로 이동한다.

| 상품구분 | 탭 라벨 | categoryId | 목록 API |
|----------|---------|-----------|----------|
| 해외패키지 | 해외 패키지 | `21241` | `/v1/discover/category/21241/brand-goods?` |
| 해외호텔 | 해외 호텔 | `21242` | `/v1/discover/category/21242/brand-goods?` |
| 현지투어 | 현지 투어 | `21243` | `/v1/discover/category/21243/brand-goods?` |

> categoryId가 바뀌면 해외 홈에서 재추출:
> ```js
> Array.from(document.querySelectorAll('a'))
>   .filter(a=>['해외패키지','해외호텔','현지투어'].includes(a.textContent.trim()))
>   .map(a=>({t:a.textContent.trim(), href:a.getAttribute('href')}));
> ```

---

## 2. 실행 방법 (권장 · 브라우저 불필요)

**Node.js 18+** 만 있으면 되고 외부 의존성 없음.

```bash
cd "/Users/rxc/Desktop/claude code/contents maker"

# 1) 전체(3종) 수집 — 가장 흔한 사용법
node prizm_overseas_crawler.js

# 2) 특정 상품구분만 (쉼표 구분, 공백 없이)
node prizm_overseas_crawler.js --types 해외호텔,현지투어

# 3) 출력 폴더/포맷/동시성 지정
node prizm_overseas_crawler.js --out ./output --format csv --concurrency 5

# 4) 상품구분별 CSV도 따로 저장(기본은 통합 1개)
node prizm_overseas_crawler.js --split
```

| 옵션 | 설명 | 기본값 |
|------|------|--------|
| `--types` | 대상 상품구분(쉼표). 생략 시 3종 전체 | 전체 |
| `--out` | 결과 저장 폴더(없으면 생성) | `검색결과` |
| `--format` | `csv` \| `json` \| `both` | `both` |
| `--concurrency` | 상세 API 동시 호출 수 | `5` |
| `--split` | 통합 파일 외에 상품구분별 CSV도 저장 | 꺼짐 |

**산출물**: `prizm_해외_{통합/상품구분}_{YYYYMMDD}.csv` (Excel용 BOM 포함), `prizm_해외_all_{YYYYMMDD}.json`.

---

## 3. 목록 API

```
GET https://api.prizm.co.kr/v1/discover/category/{categoryId}/brand-goods?
X-PRIZM-CHANNEL: MWEB     ← 필수. 없으면 400
X-PRIZM-TOKEN:            ← 비로그인 빈 값
X-PRIZM-DEVICE-ID: <UUID>
```

응답 구조(해외):
```
content: [                       // 브랜드(지역 그룹) 배열
  {
    title,                       // ★ 지역명/브랜드명 (예: "푸꾸옥 인터컨티넨탈")
    brandId,
    showRoom: null,              // ★ 해외는 null
    goodsList: [
      { goods: {
          id,                    // ★ 상품 숫자ID (상세 API + "상품id" 컬럼)
          code,                  // 상품 코드 (URL: /goods/{code})
          name,                  // 상품명
          price, consumerPrice, discountRate,
          showRoomId,            // ★ 해외는 0
          itinerary: { nights, displayText },   // 박수 ("2박"). 현지투어 단품은 null
          salesStartDate, salesEndDate,          // 판매기간(epoch ms)
          benefitLabel,          // "단독구성"
          benefitInfo: { packages: [...] },      // 카드에 뜨는 단독구성 요약(폴백용)
          status, isRunOut
      }}
    ]
  }
],
nextParameter                    // "offset=8" 있으면 다음 페이지 계속 호출
```

---

## 4. 상품 상세 API (기본 정보 / 단독 구성의 출처)

```
GET https://api.prizm.co.kr/v1/goods/{goodsId}/showroom/0
```
- 상품 페이지의 **[자세히 보기]** → `/goods/detail/{goodsId}` 페이지가 이 API로 그려진다.

🚨 **기본 정보 / 단독 구성은 상품마다 둘 중 한 구조로 온다. 둘 다 파싱해야 한다.**

**구조 A — `descriptionPackage`** (푸꾸옥·다낭 인터컨티넨탈 등)
| 화면 섹션 | 경로 |
|-----------|------|
| **기본 정보**(기본 구성: 숙소·조식) | `descriptionPackage.packageItems[]` (`{title, contents}`) |
| **단독 구성**(얼리체크인·렌터카·식사권 등) | `descriptionPackage.exclusiveItems[]` (`{title, contents}`) |

**구조 B — `keyPoints`** (JW메리어트 하노이 등 국내 호텔과 동일 구조)
| 화면 섹션 | keyPoints item.titleType |
|-----------|--------------------------|
| **기본 정보** | `PKG` ("PKG 혜택") |
| **단독 구성** | `PRIZM` ("프리즘 단독 혜택") + `CUSTOM` (특별요금 등) |

**구조 C — 자유 텍스트만** (몽골 뽀송투어, 현지투어 단품 티켓 등)
- `descriptionPackage`·`keyPoints` 모두 없고 `description` 자유 텍스트만 존재.
- 이런 상품은 **구성 섹션 자체가 없어** 기본 정보/단독 구성이 공란인 게 정상. (플래그는 `description`·상품명으로 탐지)

기타 상세 필드: `salesStartDate/salesEndDate`(판매기간), `status`/`statusText`/`isRunOut`(판매상태), `ticket.usablePeriodText`(이용 가능기간).

---

## 5. 가공 규칙

### 판매상태 (판매중 / 판매예정 / 매진)
국내와 동일. **매진의 진짜 출처는 상세 API** (목록 status/isRunOut은 신뢰 불가).
```js
const isRunOut = detail.isRunOut===true || detail.runOut===true ||
  detail.status==='TICKET_RUNOUT' || detail.statusText==='매진' || detail.isBuyAble===false;
const saleStatus = isRunOut ? '매진'
  : (detail.status==='WAIT' || (salesStart && salesStart>now)) ? '판매예정' : '판매중';
```

### 박수 ("N박 M일")
- 상품명에 `N박 M일`이 있으면 그대로 사용(예: `2박 3일ㅣ3박 4일`의 첫 매치).
- 없으면 `itinerary.nights` 로 `{nights}박 {nights+1}일` 추정. nights 없으면(현지투어 단품) 공란.

### 판매기간
`{salesStartDate 포맷} - {salesEndDate 포맷}`, 포맷은 `M. D(요일)`.

### 체크 플래그 컬럼 (상품명 + 기본정보 + 단독구성 + keyPoints원문 + description 전체에서 공백 제거 후 매칭, 있으면 `O`)
| 컬럼 | 정규식(요지) |
|------|-------------|
| 무료 객실 업그레이드 | `무료.{0,4}업그레이드`\|`객실업그레이드`\|`룸업그레이드`\|`룸UP`\|`객실UP` |
| 렌터카 포함 | `렌터카`\|`렌트카`\|`rentacar` |
| 여행자 보험 포함 | `여행자보험`\|`여행보험` |
| Gift 제공(망고 등) | `기프트`\|`gift`\|`증정`\|`웰컴기프트`\|`웰컴선물`\|`망고`\|`웰컴드링크`\|`웰컴과일` |
| 얼리 체크인 | `얼리체크인`\|`earlycheckin` |
| 레이트 체크아웃 | `레이트체크아웃`\|`늦은체크아웃`\|`latecheckout` |
| 마사지 포함 | `마사지`\|`스파`\|`massage` |
| 국적기 이용 가능 | `대한항공`\|`아시아나`\|`국적기`\|`진에어`\|`제주항공`\|`에어부산`\|`티웨이`\|`에어서울` |

> 플래그는 **키워드 휴리스틱**이라 100% 정밀하진 않다(예: 상품명에 "업그레이드"만 있고 실제 무료 혜택이 아닌 경우 등).
> 정확성이 중요하면 `기본 정보`·`단독 구성` 원문 컬럼을 함께 확인할 것.

---

## 6. 최종 컬럼 구성 (CSV)

| # | 컬럼 | 출처 |
|---|------|------|
| 1 | 상품구분 | 카테고리(해외 패키지/해외 호텔/현지 투어) |
| 2 | 지역명 | 목록 `content[].title` |
| 3 | 상품id | 목록 `goods.id`(숫자) |
| 4 | 상품명 | 목록 `goods.name` |
| 5 | 박수 | 상품명 `N박 M일` 또는 `itinerary.nights` |
| 6 | 판매가(원) | 목록 `goods.price` |
| 7 | 정가(원) | 목록 `goods.consumerPrice` |
| 8 | 할인율(%) | 목록 `goods.discountRate` |
| 9 | 판매상태 | 가공(판매중/판매예정/매진) |
| 10 | 매진 | 상세 매진이면 `O` |
| 11 | 판매기간 | 가공(salesStart~End) |
| 12 | 무료 객실 업그레이드 | 플래그 |
| 13 | 렌터카 포함 | 플래그 |
| 14 | 여행자 보험 포함 | 플래그 |
| 15 | Gift 제공(망고 등) | 플래그 |
| 16 | 얼리 체크인 | 플래그 |
| 17 | 레이트 체크아웃 | 플래그 |
| 18 | 마사지 포함 | 플래그 |
| 19 | 국적기 이용 가능 | 플래그 |
| 20 | 기본 정보 | 상세 packageItems / keyPoints(PKG) |
| 21 | 단독 구성 | 상세 exclusiveItems / keyPoints(PRIZM·CUSTOM) |
| 22 | 상품 URL | `https://mweb.prizm.co.kr/goods/{code}` |

---

## 7. 트러블슈팅

| 증상 | 원인 / 해결 |
|------|-------------|
| 목록 API 400 `E400003` | `X-PRIZM-CHANNEL: MWEB` 헤더 누락 |
| 상품 수가 적게 나옴 | 페이지네이션 미처리. `nextParameter`(offset)를 끝까지 |
| 상세 API 404 | 해외는 `/showroom/0` 이어야 함(국내처럼 실제 showRoomId 아님) |
| 기본정보/단독구성이 비어 있음 | (1) 구조 B(`keyPoints`) 미파싱 → PKG/PRIZM/CUSTOM 파싱. (2) 몽골·현지투어 단품은 원래 구성 섹션이 없음(정상) |
| 플래그가 과소 집계됨 | keyPoints 원문을 탐지 blob에 포함했는지 확인 |
