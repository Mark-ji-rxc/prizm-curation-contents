# PRIZM 지역별 상품 데이터 추출 가이드

PRIZM 모바일웹(`https://mweb.prizm.co.kr`)에서 **지역별 호텔·상품 데이터**를 긁어와 구글 스프레드시트로 정리하는 방법을 정리한 문서입니다.
다른 Claude 세션에서도 이 문서만 보고 그대로 재현할 수 있도록 작성했습니다.

> 마지막 검증: 2026-07-24 / 서울 지역 **14개 호텔 · 70개 상품** 추출 완료
> 생성 시트: `PRIZM 서울 지역 상품 리스트 (전체 70건)` (구글 스프레드시트)
> 실행 도구: 같은 폴더의 `prizm_crawler.js` — `node prizm_crawler.js --regions 서울`
>
> **변경 이력**
> - 2026-07-30: **상품ID/상품코드 구분 명확화 + 판매일자 컬럼 추가**. `상품ID` = 목록 `goods.id`(숫자 5~6자리, 내부 식별자·상세 API/등록 매칭용). `상품코드` = `goods.code`(영문, 상품 URL `/goods/{code}`). 이전엔 `상품ID` 컬럼에 코드(영문)를 넣었으나, 이제 **`상품ID`(숫자)와 `상품코드`(영문)를 각각 별도 컬럼**으로 출력한다. 또 `판매시작일`·`판매종료일`(ISO yyyy-mm-dd, 상시판매면 종료일 빈 값) 컬럼을 추가(판매기간 조건 필터용).
> - 2026-07-24: **매진 컬럼 추가**. 상품 상세페이지에 "매진" 표기된 상품을 별도 컬럼(`매진` = `O`)으로 표시. 판매상태 컬럼에도 `매진` 값 반영. (검증: 경상 240개 중 23개 매진 탐지)
> - 2026-07-24: **CSV 출력을 통합 1개 파일로 변경**. 기존엔 지역별로 CSV가 나뉘었으나, 이제 기본적으로 모든 지역을 합쳐 `prizm_{지역/통합}_{날짜}.csv` **한 파일**로 저장. 예전처럼 지역별로 나누려면 `--split` 옵션 사용.
> - 2026-07-24: **기본 저장 폴더를 `검색결과`로 변경**. `--out` 미지정 시 결과물이 실행 폴더 하위 `검색결과/`에 저장됨(자동 생성). 다른 폴더에 저장하려면 `--out ./경로` 사용.

---

## 0. 핵심 요약 (TL;DR)

- PRIZM 웹은 **SSR 셸만 내려주는 SPA**라서 `fetch(페이지URL)`로는 내용이 안 나온다. → **내부 REST API를 직접 호출**하는 게 정답.
- 데이터는 전부 `https://api.prizm.co.kr` 에 있다.
- 필요한 API는 딱 2개:
  1. **지역 목록**: `GET /v1/discover/category/{categoryId}/brand-goods?` → 호텔·상품·가격·박수·판매기간·숫자ID·쇼룸ID
  2. **상품 상세**: `GET /v1/goods/{goodsNumericId}/showroom/{showRoomId}` → 패키지 포함내역·투숙인원·체크인아웃·투숙가능기간
- ✅ **브라우저 불필요.** 아래 헤더만 붙이면 순수 HTTP(curl/Node/Python)로 동작한다:
  ```
  X-PRIZM-CHANNEL: MWEB      ← 이게 핵심. 없으면 400 (E400003 "입력값이 올바르지 않습니다")
  X-PRIZM-TOKEN:             ← 비로그인은 빈 값
  X-PRIZM-DEVICE-ID: <아무 UUID>
  ```
- 🚨 **반드시 페이지네이션을 돌 것.** 목록 API는 브랜드(호텔) 8개 단위로 끊어서 준다.
  응답의 `nextParameter`(예: `offset=8`)가 있으면 `...brand-goods?offset=8` 로 계속 호출해야 한다.
  **웹 화면만 보고 긁으면 첫 페이지(호텔 8개)만 잡혀 데이터가 누락된다.**
  (실측: 서울은 첫 페이지 8개 호텔/34개 상품이지만, 전체는 **14개 호텔 / 70개 상품**)
- 바로 쓸 수 있는 구현체: 같은 폴더의 **`prizm_crawler.js`** (Node 18+, 의존성 없음).

---

## 1. 지역 → categoryId 매핑

지역 탭(국내)을 클릭하면 `/section/category/{categoryId}` 로 이동한다. 각 지역의 categoryId는 다음과 같다.

| 지역 | categoryId | 목록 API |
|------|-----------|----------|
| 서울 | `21233` | `/v1/discover/category/21233/brand-goods?` |
| 제주 | `21234` | `/v1/discover/category/21234/brand-goods?` |
| 부산 | `21235` | `/v1/discover/category/21235/brand-goods?` |
| 강원 | `21236` | `/v1/discover/category/21236/brand-goods?` |
| 경기·인천 | `21237` | `/v1/discover/category/21237/brand-goods?` |
| 경상 | `21238` | `/v1/discover/category/21238/brand-goods?` |
| 전라 | `21239` | `/v1/discover/category/21239/brand-goods?` |
| 충청 | `21240` | `/v1/discover/category/21240/brand-goods?` |

> categoryId가 바뀔 수 있으니, 확인하려면 홈에서 아래 스니펫으로 재추출한다:
> ```js
> Array.from(document.querySelectorAll('a'))
>   .filter(a=>['서울','제주','부산','강원','경기·인천','경상','전라','충청'].includes(a.textContent.trim()))
>   .map(a=>({t:a.textContent.trim(), href:a.getAttribute('href')}));
> ```

---

## 1.5. `prizm_crawler.js` 실행 방법 (권장 · 브라우저 불필요)

같은 폴더의 `prizm_crawler.js`가 위 전 과정(목록→상세→가공→CSV/JSON)을 자동으로 수행한다. **Node.js 18 이상**만 있으면 되고 외부 의존성(npm install)은 없다.

```bash
# 터미널에서 스크립트가 있는 폴더로 이동
cd "/Users/rxc/Desktop/claude code/contents maker"

# 1) 특정 지역만 (가장 흔한 사용법)
node prizm_crawler.js --regions 서울

# 2) 여러 지역 (쉼표로 구분, 공백 없이)
node prizm_crawler.js --regions 서울,제주,경상

# 3) 전체 지역 (인자 없이 실행)
node prizm_crawler.js

# 4) 출력 폴더 지정 + 포맷 선택 + 동시요청 수 조절
node prizm_crawler.js --regions 강원 --out ./output --format both --concurrency 4

# 5) (선택) 지역별 CSV를 따로 나눠서도 저장하고 싶을 때
node prizm_crawler.js --regions 서울,부산 --split
```

**옵션 정리**
| 옵션 | 설명 | 기본값 |
|------|------|--------|
| `--regions` | 대상 지역(쉼표 구분). 생략 시 8개 지역 전체 | 전체 |
| `--out` | 결과 저장 폴더 (없으면 자동 생성) | `검색결과` |
| `--format` | `csv` \| `json` \| `both` | `both` |
| `--concurrency` | 상세 API 동시 호출 수 | `4` |
| `--split` | 통합 파일 외에 **지역별 CSV도 따로** 저장 | 꺼짐 |

**산출물** (기본 `검색결과/` 폴더에 저장, `--out`으로 변경 가능. `YYYYMMDD`는 실행일)
- `prizm_{지역/통합}_{YYYYMMDD}.csv` — **모든 지역을 합친 통합 CSV 1개** (기본). 지역 1개면 그 지역명, 2개 이상이면 `통합`. Excel 한글 안 깨지게 BOM 포함.
- `prizm_{지역}_{YYYYMMDD}.csv` — `--split` 줬을 때만 지역별로 추가 생성.
- `prizm_all_{YYYYMMDD}.json` — 전체 통합 JSON (`--format json`/`both`).

> **실행 확인**: 실행하면 `[지역] 목록 수집 중… N개 상품` → `[지역] 상세 수집 n/N` 진행률이 뜨고, 마지막에 지역별 호텔/상품 개수 요약이 출력된다.
> **Node 버전 확인**: `node -v` 로 v18 이상인지 확인. 낮으면 내장 `fetch`가 없어 에러가 난다.
> CSV를 구글 스프레드시트로 올리는 방법은 아래 8번 참고.

---

## 2. 전체 실행 흐름 (수동/브라우저 방식 — 참고용)

1. Browser 탭에서 `https://mweb.prizm.co.kr/?region=domestic` 접속 (앱 다운로드 팝업 뜨면 "나중에" 클릭).
2. 대상 지역 categoryId 확보 (위 표 또는 스니펫).
3. **지역 목록 API 호출** → 상품 배열(숫자ID, 쇼룸ID, 코드, 호텔명, 가격, 박수, 판매기간 등) 확보.
4. 각 상품에 대해 **상세 API 호출** → 패키지 포함내역·투숙인원·체크인아웃·투숙가능기간 확보.
5. 필드 가공(플래그 컬럼, 판매상태 등) 후 CSV 생성.
6. CSV를 구글 드라이브에 `text/csv`로 업로드 → 자동으로 **구글 스프레드시트**로 변환.

> 상세 API는 상품 수만큼 호출해야 하므로, 한 번의 `javascript_tool` 호출에서 30초 타임아웃에 걸릴 수 있다.
> **상품 20개 내외로 배치를 나눠** `sessionStorage`에 누적 저장하면 안전하다. (서울 34개는 1회에 아슬아슬하게 들어감)

---

## 3. 지역 목록 API 상세

### 요청
```
GET https://api.prizm.co.kr/v1/discover/category/{categoryId}/brand-goods?
Accept: application/json
X-PRIZM-CHANNEL: MWEB
X-PRIZM-TOKEN:
X-PRIZM-DEVICE-ID: <아무 UUID>
```
- ⚠️ `X-PRIZM-CHANNEL: MWEB` 가 없으면 `E400003 / 입력값이 올바르지 않습니다` 400 발생. 이 헤더만 있으면 서버 어디서든 호출 가능.
- 카테고리 하위 필터: `?categoryFilter={id}` (예: 프리미엄 호텔 등). **전체는 파라미터 없이 `?`** 로 호출.
- 🚨 **페이지네이션 필수**: 응답 `nextParameter`(예: `offset=8`)가 있으면 `?offset=8` 로 계속 호출.
  브랜드 8개 단위로 끊기므로 **한 번만 호출하면 대부분의 상품이 누락된다.**
  중복 방지를 위해 `goods.code` 기준으로 dedupe 할 것.

### 응답 구조
```
{
  metadata,
  content: [                      // 브랜드(호텔) 배열
    {
      title,                      // 호텔명(공백 없이 붙는 경우 있음 → showRoom.name/place.name로 교정)
      brandId,
      showRoom: {
        id,                       // ★ 쇼룸ID (상세 API에 필요)
        name, code,
        tags: [ {type:'ADDRESS', value:'서울 영등포구'}, {type:'TAG', value:'프리미엄 호텔'} ]
      },
      goodsList: [
        {
          goods: {
            id,                   // ★ 상품 숫자ID (상세 API에 필요)
            code,                 // 상품 코드 (URL용: /goods/{code})
            name,                 // 상품명
            price, consumerPrice, discountRate,
            showRoomId,           // ★ 쇼룸ID
            itinerary: { nights, displayText },   // 박수 ("1박")
            salesStartDate, salesEndDate,         // 판매기간(epoch ms). salesEndDate=null → 상시판매
            status, type, labels, benefitLabel
          }
        }
      ]
    }
  ],
  nextParameter
}
```

### 목록 파싱 스니펫
```js
// resp = 위 API 응답 JSON
const rows = [];
(resp.content||[]).forEach(b=>{
  const sr = b.showRoom||{};
  const addr = (sr.tags||[]).find(t=>t.type==='ADDRESS')?.value||'';
  const cat  = (sr.tags||[]).find(t=>t.type==='TAG')?.value||'';
  (b.goodsList||[]).forEach(gl=>{
    const g = gl.goods;
    rows.push({
      numId:g.id, showRoomId:g.showRoomId, code:g.code,
      hotel: sr.name||b.title, address:addr, category:cat,
      name:g.name, price:g.price, consumerPrice:g.consumerPrice, discountRate:g.discountRate,
      nights:g.itinerary?.displayText||'',
      salesStart:g.salesStartDate, salesEnd:g.salesEndDate, status:g.status
    });
  });
});
```

> **호텔명 주의**: `brand.title`과 `showRoom.name`이 공백 없이 붙어 나오는 경우가 있다(예: `그랜드머큐어임피리얼팰리스강남`).
> 정확한 표기는 상세 API의 `ticket.place.name`에 있으니, 필요하면 그것으로 교정한다.

---

## 4. 상품 상세 API 상세

### 요청
```
GET https://api.prizm.co.kr/v1/goods/{goodsNumericId}/showroom/{showRoomId}
Accept: application/json
```
- 일반 fetch로 200 OK (특별한 헤더 불필요). 단 mweb 오리진에서 호출 권장.

### 핵심 필드
| 목적 | 경로 | 비고 |
|------|------|------|
| 패키지 포함내역 + 투숙인원 | `keyPoints.items[]` | 각 item = `{titleType, title, contents}` |
| → 패키지 포함내역 | `titleType !== 'GUEST_COUNT'` 인 item 전부 | PKG/PRIZM/CUSTOM 등 |
| → 투숙인원 | `titleType === 'GUEST_COUNT'` 인 item의 `contents` | "기준 …\n최대 …" |
| 투숙인원(객실 기준) 폴백 | `accomTop.rooms[0].stdPersonsText` / `maxPersonsText` | GUEST_COUNT 없을 때 |
| 체크인/체크아웃 | `ticket.checkInOut.{checkIn,checkOut}` 또는 `accomTop.{checkInTime,checkOutTime}` | "오후 3시" / "오전 11시" |
| **투숙 가능기간** | `ticket.usablePeriodText` | 라벨: `ticket.usablePeriodTitle`("체크인 가능 기간"). **판매기간 아님!** |
| **판매기간** | `salesStartDate` ~ `salesEndDate` | epoch ms. **`salesEndDate=null`이면 "상시판매"** |
| 주소(정식) | `ticket.place.name`, `ticket.place.address` | 호텔명 교정용 |

> ⚠️ **판매기간 vs 투숙가능기간 구분 (중요)**
> - **판매기간** = 상품이 판매되는 기간. 상품 페이지 상단 히어로 이미지에 `판매 기간 7. 23(목) - 7. 30(목)` + `D-6` 형태로 오버레이됨(LIVE/한정 상품). → API의 `salesStartDate/salesEndDate`.
> - **판매기간 표기가 없으면 → "상시판매"로 분류** (`salesEndDate`가 null인 상시 판매 상품).
> - **투숙 가능기간(=체크인 가능 기간)** = 실제 투숙(체크인) 가능한 날짜 범위. → API의 `ticket.usablePeriodText`. 판매기간과 다른 별도 컬럼.

### keyPoints 예시
```json
"keyPoints": {
  "type": "POINT_MULTI",
  "items": [
    {"titleType":"PKG",   "title":"PKG 혜택",       "contents":"• …\n• …"},
    {"titleType":"PRIZM", "title":"프리즘 단독 혜택", "contents":"• …"},
    {"titleType":"CUSTOM","title":"라비앙 X 웰니스 혜택","contents":"• …"},
    {"titleType":"GUEST_COUNT","title":"투숙 인원","contents":"기준 성인 2인 + 소아 1인\n최대 성인 2인 + 소아 2인"}
  ]
}
```

---

## 5. 가공 규칙

### 매진 여부 (⭐ 2026-07-24 추가)
상품 상세페이지 하단 구매 버튼이 회색 **"매진"** 으로 바뀐 상품(예: 금호통영마리나리조트 패밀리 프리미어)을 잡아낸다.

> 🚨 **핵심 주의: 목록 API의 `status`/`isRunOut`은 매진이어도 `NORMAL`/`false`로 온다(신뢰 불가).**
> **매진의 진짜 출처는 상세 API(`/v1/goods/{id}/showroom/{showRoomId}`)다.** 상세 API에서 아래 중 하나라도 참이면 매진:
> | 필드 | 매진일 때 값 |
> |------|------------|
> | `status` | `"TICKET_RUNOUT"` |
> | `statusText` | `"매진"` |
> | `isRunOut` | `true` |
> | `runOut` | `true` |
> | `isBuyAble` | `false` |

- 상세 API `status` 값 분포 (실측): `NORMAL`(구매/판매중) · `WAIT`(알림 신청/판매예정) · `TICKET_RUNOUT`(매진).
- 판정 코드:
```js
const isRunOut =
  detail.isRunOut === true ||
  detail.status === 'TICKET_RUNOUT' ||
  detail.statusText === '매진';
```
- 출력: **`매진` 컬럼** = 매진이면 `O`, 아니면 공란.

### 판매상태 (판매중 / 판매예정 / 매진)
- 매진(위 `isRunOut`)이면 → **매진**
- 상세 `status === 'WAIT'` 또는 `salesStartDate > 현재시각(now)` → **판매예정** (상품 카드 우측 하단에 "알림 신청" 버튼 노출)
- 그 외 → **판매중**

### 판매기간
- `salesEndDate`가 있으면 → `{salesStartDate 포맷} - {salesEndDate 포맷}`
- `salesEndDate`가 null이면 → **"상시판매"**
- 날짜 포맷 함수:
```js
function fmt(ms){
  if(!ms) return '';
  const d=new Date(ms), w=['일','월','화','수','목','금','토'][d.getDay()];
  return `${d.getMonth()+1}. ${d.getDate()}(${w})`;
}
```

### 투숙인원 → 기준 / 최대 분리 (각각 별도 컬럼)
- GUEST_COUNT `contents`를 줄바꿈으로 나눠 `기준`/`최대` 프리픽스로 분리.
- 없으면 `accomTop.rooms[0].stdPersonsText`(기준), `maxPersonsText`(최대) 사용.

### 플래그 컬럼 (상품명 + 패키지 포함내역 텍스트 전체에서 키워드 탐지, 있으면 `O`)
공백 제거한 텍스트(`blob`)에서 정규식 매칭:
| 컬럼 | 탐지 정규식(예) |
|------|----------------|
| 레이트 체크아웃 | `레이트체크아웃` 또는 `\d+시레이트체크아웃` 또는 `늦은체크아웃` |
| 레이트 체크인 | `레이트체크인` |
| 24시간 스테이 | `24시간스테이` |
| 인원추가비 무료(최대인원까지) | `인원추가비용무료`\|`인원추가비무료`\|`인원추가무료`\|`최대인원까지인원추가` |
| 라운지 | `라운지` |
| 조식 | `조식`\|`모닝`\|`브렉퍼스트`\|`아침식사` — **단 라운지가 있으면 공란**(아래 규칙) |
| 디너 | `디너`\|`석식` |
| 굿즈 제공 | `인형`\|`텀블러`\|`안마기기`\|`마사지기`\|`굿즈`\|`어메니티`\|`스킨케어`\|`이너뷰티`\|`뷰티PKG`\|`키트`\|`피규어` |

> **라운지 우선 규칙(중요)**: 라운지 상품에 조식이 함께 포함된 경우(예: "골드라운지 … - 골드 라운지 조식")는
> **라운지로만 표기하고 조식은 공란**으로 둔다. → `조식 = (조식키워드 && !라운지)`

> 서울 같은 도심 호텔은 레이트체크아웃/24시간스테이가 거의 없는 게 정상. 소노캄·리조트류에서 주로 등장.

### 호텔명 보정
목록의 `showRoom.name` 이 기본이지만 간혹 공백 없이 붙어 나온다(`그랜드머큐어임피리얼팰리스강남`, `롯데호텔서울`).
**공백이 없을 때만** 상세의 `brand.name`(띄어쓰기 정상)으로 교체한다. `ticket.place.name`은 정식명칭이지만
불필요한 접미어가 붙는 경우가 있어(`… - 서울 드래곤 시티`) 1순위로는 쓰지 않는다.

---

## 6. 최종 컬럼 구성 (구글 시트)

| # | 컬럼 | 출처 |
|---|------|------|
| 1 | 지역 | 고정값 |
| 2 | 호텔명 | 목록 `showRoom.name`(교정) |
| 3 | **상품ID** | 목록 `goods.code` ⭐신규 |
| 4 | 상품명 | 목록 `goods.name` |
| 5 | 박수 | 목록 `itinerary.displayText` |
| 6 | 판매가(원) | 목록 `price` |
| 7 | 정가(원) | 목록 `consumerPrice` |
| 8 | 할인율(%) | 목록 `discountRate` |
| 9 | 판매상태 | 가공(판매중/판매예정/매진) |
| 10 | 매진 | 가공 플래그(상세 API 매진이면 `O`) |
| 11 | 판매기간 | 가공(salesStart~End 또는 상시판매) |
| 12 | 투숙가능기간 | 상세 `ticket.usablePeriodText` |
| 13 | 투숙인원(기준) | 상세 GUEST_COUNT/accomTop |
| 14 | 투숙인원(최대) | 상세 GUEST_COUNT/accomTop |
| 15 | 체크인 | 상세 `ticket.checkInOut.checkIn` |
| 16 | 체크아웃 | 상세 `ticket.checkInOut.checkOut` |
| 17 | 레이트 체크아웃 | 가공 플래그 |
| 18 | 레이트 체크인 | 가공 플래그 |
| 19 | 24시간 스테이 | 가공 플래그 |
| 20 | 인원추가비 무료(최대인원까지) | 가공 플래그 |
| 21 | 조식 | 가공 플래그(라운지 있으면 공란) |
| 22 | 디너 | 가공 플래그 |
| 23 | 라운지 | 가공 플래그 |
| 24 | 굿즈 제공 | 가공 플래그 |
| 25 | 패키지 포함내역 | 상세 keyPoints(비-GUEST_COUNT) 조합 |
| 26 | 상품 URL | `https://mweb.prizm.co.kr/goods/{code}` |

---

## 7. 참고: 브라우저에서 한 지역 통째로 수집하는 스니펫

> `mweb.prizm.co.kr`가 열린 Browser 탭의 `javascript_tool`에서 실행.
> 목록 API는 앱이 실제로 호출하도록 유도(정렬/필터 클릭)해서 응답을 가로채는 방법이 가장 확실하다.
> 아래는 상세 수집 루프 예시(목록 rows가 이미 `seoul_list`에 있다고 가정).

```js
(async()=>{
  const list = JSON.parse(sessionStorage.getItem('seoul_list')||'[]');
  const now = Date.now();
  const fmt = ms => { if(!ms) return ''; const d=new Date(ms),w=['일','월','화','수','목','금','토'][d.getDay()]; return `${d.getMonth()+1}. ${d.getDate()}(${w})`; };
  const rows = JSON.parse(sessionStorage.getItem('seoul_rows')||'[]');
  const done = new Set(rows.map(r=>r.code));
  for(const it of list){
    if(done.has(it.code)) continue;
    const r = await fetch(`https://api.prizm.co.kr/v1/goods/${it.numId}/showroom/${it.showRoomId}`,{headers:{accept:'application/json'}});
    const j = await r.json();
    const kp = j.keyPoints?.items||[];
    const pkg = kp.filter(x=>x.titleType!=='GUEST_COUNT').map(x=>`[${x.title}]\n${x.contents}`).join('\n\n');
    const guest = kp.find(x=>x.titleType==='GUEST_COUNT');
    let base='',max='';
    guest?.contents.split('\n').forEach(l=>{l=l.trim(); if(/^기준/.test(l))base=l.replace(/^기준\s*/,''); if(/^최대/.test(l))max=l.replace(/^최대\s*/,'');});
    const rm = j.accomTop?.rooms?.[0];
    if(!base&&rm) base=(rm.stdPersonsText||'').replace(/^기준\s*/,'');
    if(!max&&rm)  max =(rm.maxPersonsText||'').replace(/^최대\s*/,'');
    const tk = j.ticket||{};
    const ss=j.salesStartDate??it.salesStart, se=j.salesEndDate??it.salesEnd;
    const blob=(it.name+' '+pkg).replace(/\s/g,'');
    rows.push({
      region:'서울', hotel:it.hotel, name:it.name, nights:it.nights,
      price:it.price, consumerPrice:it.consumerPrice, discountRate:it.discountRate,
      saleStatus:(ss&&ss>now)?'판매예정':'판매중',
      salePeriod: se ? `${fmt(ss)} - ${fmt(se)}` : '상시판매',
      stayPeriod: tk.usablePeriodText||'',
      base, max,
      checkIn: tk.checkInOut?.checkIn||j.accomTop?.checkInTime||'',
      checkOut: tk.checkInOut?.checkOut||j.accomTop?.checkOutTime||'',
      fLateOut: (/레이트체크아웃|늦은체크아웃/.test(blob)||/\d+시레이트체크아웃/.test(blob))?'O':'',
      fLateIn : /레이트체크인/.test(blob)?'O':'',
      f24     : /24시간스테이/.test(blob)?'O':'',
      fAddFree: /인원추가비용무료|인원추가비무료|인원추가무료|최대인원까지인원추가/.test(blob)?'O':'',
      pkg, code:it.code, url:`https://mweb.prizm.co.kr/goods/${it.code}`
    });
    sessionStorage.setItem('seoul_rows', JSON.stringify(rows));  // 배치 중간에도 누적 저장
    await new Promise(r=>setTimeout(r,120));
  }
  return {done:rows.length};
})();
```

---

## 8. CSV → 구글 스프레드시트 만들기

1. 위 rows로 CSV 문자열 생성(값에 `,` `"` 개행 포함 시 `"`로 감싸고 내부 `"`는 `""`로 이스케이프).
2. 구글 드라이브 업로드 툴로 `contentMimeType: text/csv`, `disableConversionToGoogleType` 미설정(=변환 허용) 으로 업로드 → 자동으로 `application/vnd.google-apps.spreadsheet`로 변환됨.
3. 패키지 포함내역은 셀 안에 개행이 유지된다(CSV 따옴표 인용 덕분).

> 판매가/정가/할인율은 숫자(원 단위, 콤마 없이)로 저장해 정렬·계산이 가능하게 함.

---

## 9. 트러블슈팅

| 증상 | 원인 / 해결 |
|------|-------------|
| `fetch(페이지URL)` 결과에 상품 내용 없음 | SPA 셸만 옴. → API 직접 호출로 전환 |
| 목록 API 400 `E400003` | `X-PRIZM-CHANNEL: MWEB` 헤더 누락. 헤더 추가하면 해결 |
| **상품 수가 적게 나옴(누락)** | 페이지네이션 미처리. `nextParameter`(`offset=N`)를 끝까지 따라가야 함. 웹 화면 스크롤만 믿지 말 것 |
| `javascript_tool` 30초 타임아웃 | 상세 호출 루프가 김. → 20개 내외 배치로 나눠 `sessionStorage`에 누적 |
| 호텔명이 공백 없이 붙음 | `ticket.place.name`으로 교정 |
| 판매기간이 비어 있음 | 정상. `salesEndDate=null` → "상시판매" |
| 앱 다운로드 팝업 | "나중에" 버튼 클릭 후 진행 |
