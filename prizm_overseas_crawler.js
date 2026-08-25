#!/usr/bin/env node
/**
 * PRIZM 해외 상품 크롤러 (해외패키지 · 해외호텔 · 현지투어)
 * -----------------------------------------------------------------------------
 * PRIZM 모바일웹(mweb.prizm.co.kr)의 내부 REST API를 직접 호출해
 * 해외 여행상품(해외패키지/해외호텔/현지투어) 데이터를 수집하고 CSV / JSON 으로 저장한다.
 *
 * 국내 호텔 크롤러(prizm_crawler.js)와 같은 방식이지만, 해외 상품은 구조가 다르다:
 *   - 목록 응답에 showRoom 이 null 이고 showRoomId 가 0 → 상세 API는 /showroom/0 으로 호출.
 *   - 지역/브랜드 그룹은 brand.title (예: "푸꾸옥 인터컨티넨탈", "오키나와 자유 패키지").
 *   - "기본 정보"·"단독 구성"은 상세 API의 descriptionPackage 안에 있다:
 *        descriptionPackage.packageItems[]   → 기본 정보(숙소·조식 등 기본 구성)
 *        descriptionPackage.exclusiveItems[] → 단독 구성(얼리체크인·렌터카·식사권 등)
 *
 * 브라우저 없이 순수 HTTP 로 동작 (핵심: X-PRIZM-CHANNEL: MWEB 헤더).
 * 요구사항: Node.js 18+ (내장 fetch 사용, 외부 의존성 없음)
 *
 * 사용법:
 *   node prizm_overseas_crawler.js                          # 3종 전체, CSV+JSON
 *   node prizm_overseas_crawler.js --types 해외호텔,현지투어   # 특정 상품구분만
 *   node prizm_overseas_crawler.js --out ./output           # 출력 폴더 지정
 *   node prizm_overseas_crawler.js --format csv             # csv | json | both(기본)
 *   node prizm_overseas_crawler.js --concurrency 5          # 상세조회 동시 요청 수(기본 5)
 *   node prizm_overseas_crawler.js --split                  # 상품구분별 CSV도 따로 저장
 *
 * 산출물: {out}/prizm_해외_{상품구분/통합}_{YYYYMMDD}.csv  및  ..._해외_all_{YYYYMMDD}.json
 * -----------------------------------------------------------------------------
 */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── 설정 ─────────────────────────────────────────────────────────────────────
const API = 'https://api.prizm.co.kr';
const WEB = 'https://mweb.prizm.co.kr';

// 상품구분 → categoryId (2026-07 기준, /?region=international 탭 링크의 숫자).
// 변경 시 해외 홈에서 아래 스니펫으로 재추출:
//   Array.from(document.querySelectorAll('a'))
//     .filter(a=>['해외패키지','해외호텔','현지투어'].includes(a.textContent.trim()))
//     .map(a=>({t:a.textContent.trim(), href:a.getAttribute('href')}));
const TYPES = {
  '해외패키지': { categoryId: 21241, label: '해외 패키지' },
  '해외호텔': { categoryId: 21242, label: '해외 호텔' },
  '현지투어': { categoryId: 21243, label: '현지 투어' },
};

// 앱이 붙이는 필수 헤더. 토큰은 비로그인 상태에서 빈 값으로 동작.
const HEADERS = {
  accept: 'application/json, text/plain, */*',
  'X-PRIZM-CHANNEL': 'MWEB',
  'X-PRIZM-TOKEN': '',
  'X-PRIZM-DEVICE-ID': crypto.randomUUID(),
  'user-agent': 'Mozilla/5.0 (prizm-overseas-crawler)',
  origin: WEB,
  referer: WEB + '/',
};

// ── 유틸 ─────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WD = ['일', '월', '화', '수', '목', '금', '토'];
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getMonth() + 1}. ${d.getDate()}(${WD[d.getDay()]})`;
}

async function getJSON(url, { retries = 3 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(500 * (i + 1));
    }
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur], cur);
    }
  });
  await Promise.all(workers);
  return out;
}

function csvEscape(v) {
  v = v == null ? '' : String(v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

// 박수 → "N박 M일". 상품명에 "N박 M일"이 있으면 그대로, 없으면 nights+1일로 추정.
function fmtNights(nights, name) {
  const m = (name || '').match(/(\d+)\s*박\s*(\d+)\s*일/);
  if (m) return `${m[1]}박 ${m[2]}일`;
  if (nights != null && nights > 0) return `${nights}박 ${nights + 1}일`;
  return '';
}

// ── 목록 수집 (상품구분 카테고리, 페이지네이션 포함) ─────────────────────────
async function fetchTypeList(typeName, categoryId) {
  const rows = [];
  const seen = new Set();
  let offset = null; // nextParameter 예: "offset=8"
  for (let page = 0; page < 50; page++) {
    const qs = offset != null ? `?${offset}` : '?';
    const j = await getJSON(`${API}/v1/discover/category/${categoryId}/brand-goods${qs}`);
    const content = (j && j.content) || [];
    if (!content.length) break;
    for (const b of content) {
      // 해외는 showRoom 이 null. 지역/브랜드명은 brand.title.
      const region = b.title || '';
      for (const gl of b.goodsList || []) {
        const g = gl.goods;
        if (!g || seen.has(g.code)) continue;
        seen.add(g.code);
        rows.push({
          type: typeName,
          region,
          numId: g.id,
          showRoomId: g.showRoomId ?? 0, // 해외는 0
          code: g.code,
          name: (g.name || '').trim(),
          price: g.price,
          consumerPrice: g.consumerPrice,
          discountRate: g.discountRate,
          nights: (g.itinerary && g.itinerary.nights) ?? null,
          salesStart: g.salesStartDate,
          salesEnd: g.salesEndDate,
          status: g.status,
          // 목록 단계에서도 확보되는 단독구성 요약(폴백용)
          listPackages: (g.benefitInfo && g.benefitInfo.packages) || [],
        });
      }
    }
    if (!j.nextParameter) break;
    offset = j.nextParameter;
    await sleep(120);
  }
  return rows;
}

// ── 플래그 키워드 (상품명 + 기본정보 + 단독구성 + 설명 전체에서, 공백 제거 후 매칭) ──
const FLAGS = {
  '무료 객실 업그레이드': /무료.{0,4}업그레이드|객실업그레이드|룸업그레이드|룸UP|객실UP|업그레이드무료|무료업그레이드/i,
  '렌터카 포함': /렌터카|렌트카|rentacar/i,
  '여행자 보험 포함': /여행자보험|여행보험/,
  'Gift 제공(망고 등)': /기프트|gift|증정|웰컴선물|웰컴기프트|망고|웰컴드링크|웰컴과일/i,
  '얼리 체크인': /얼리체크인|얼리체크-?인|earlycheck-?in/i,
  '레이트 체크아웃': /레이트체크아웃|레이트체크-?아웃|늦은체크아웃|latecheck-?out/i,
  '마사지 포함': /마사지|스파(?!이)|massage/i,
  '국적기 이용 가능': /대한항공|아시아나|국적기|진에어|제주항공|에어부산|티웨이|에어서울/,
};
const flag = (b) => (b ? 'O' : '');

// ── 상세 수집 & 가공 ─────────────────────────────────────────────────────────
async function enrich(row) {
  const now = Date.now();
  let detail = {};
  try {
    detail = await getJSON(`${API}/v1/goods/${row.numId}/showroom/${row.showRoomId}`);
  } catch (e) {
    detail = {};
  }

  // 해외 상품의 "기본 정보 / 단독 구성"은 두 가지 구조로 내려온다.
  //  (A) descriptionPackage: packageItems(기본) / exclusiveItems(단독)     ← 푸꾸옥·다낭 등
  //  (B) keyPoints.items: titleType PKG(기본) / PRIZM·CUSTOM(단독)          ← JW메리어트 등(국내 호텔과 동일)
  // 둘 다 합쳐서 채운다.
  const dp = detail.descriptionPackage || {};
  const kp = (detail.keyPoints && detail.keyPoints.items) || [];
  const item = (x) => `[${(x.title || '').trim()}]\n${(x.contents || '').trim()}`.trim();

  const basicParts = [];
  (dp.packageItems || []).forEach((x) => basicParts.push(item(x)));
  kp.filter((x) => x.titleType === 'PKG').forEach((x) => basicParts.push(item(x)));

  const excParts = [];
  (dp.exclusiveItems || []).forEach((x) => excParts.push(item(x)));
  kp.filter((x) => x.titleType === 'PRIZM' || x.titleType === 'CUSTOM').forEach((x) => excParts.push(item(x)));

  const 기본정보 = basicParts.join('\n\n');
  let 단독구성 = excParts.join('\n\n');
  // 구조화된 단독구성이 없으면 목록의 benefitInfo.packages(카드에 뜨는 단독구성 요약)로 폴백
  if (!단독구성 && row.listPackages.length) {
    단독구성 = row.listPackages.map((p) => `• ${p}`).join('\n');
  }
  // keyPoints 전체 원문(분류와 무관하게 플래그 탐지에 사용)
  const kpAll = kp.map((x) => `${x.title || ''} ${x.contents || ''}`).join(' ');

  // 판매기간 (상세 우선)
  const ss = detail.salesStartDate ?? row.salesStart;
  const se = detail.salesEndDate ?? row.salesEnd;
  const salePeriod = ss || se ? `${fmtDate(ss)} - ${fmtDate(se)}` : '';

  // 매진 여부: 상세 API가 진짜 출처 (목록 status/isRunOut 은 신뢰 불가)
  const isRunOut =
    detail.isRunOut === true ||
    detail.runOut === true ||
    detail.status === 'TICKET_RUNOUT' ||
    detail.statusText === '매진' ||
    detail.isBuyAble === false;

  // 판매상태: 매진 > 판매예정(WAIT/판매시작 미래) > 판매중
  const saleStatus = isRunOut
    ? '매진'
    : detail.status === 'WAIT' || (ss && ss > now)
    ? '판매예정'
    : '판매중';

  // 플래그 판정용 통합 텍스트 (공백 제거)
  const blob = [row.name, 기본정보, 단독구성, kpAll, detail.description || '', row.listPackages.join(' ')]
    .join(' ')
    .replace(/\s/g, '');
  const flags = {};
  for (const [col, re] of Object.entries(FLAGS)) flags[col] = flag(re.test(blob));

  return {
    상품구분: TYPES[row.type].label,
    지역명: row.region,
    상품id: row.numId,   // 내부 상품 식별자(숫자 5~6자리). 등록/API 매칭용.
    상품코드: row.code,  // 상품 URL(/goods/<코드>)에 쓰이는 영문 코드.
    상품명: row.name,
    박수: fmtNights(row.nights, row.name),
    '판매가(원)': row.price,
    '정가(원)': row.consumerPrice,
    '할인율(%)': row.discountRate,
    판매상태: saleStatus,
    매진: flag(isRunOut),
    판매기간: salePeriod,
    판매시작일: ss ? new Date(ss).toISOString().slice(0, 10) : '',
    판매종료일: se ? new Date(se).toISOString().slice(0, 10) : '', // 상시판매면 빈 값
    ...flags,
    '기본 정보': 기본정보,
    '단독 구성': 단독구성,
    '상품 URL': `${WEB}/goods/${row.code}`,
  };
}

const COLUMNS = [
  '상품구분', '지역명', '상품id', '상품코드', '상품명', '박수',
  '판매가(원)', '정가(원)', '할인율(%)', '판매상태', '매진', '판매기간', '판매시작일', '판매종료일',
  ...Object.keys(FLAGS), // 무료 객실 업그레이드 … 국적기 이용 가능
  '기본 정보', '단독 구성', '상품 URL',
];

function toCSV(records) {
  const lines = [COLUMNS.map(csvEscape).join(',')];
  for (const r of records) lines.push(COLUMNS.map((c) => csvEscape(r[c])).join(','));
  return '﻿' + lines.join('\n'); // BOM: Excel 한글 깨짐 방지
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { types: null, out: '검색결과', format: 'both', concurrency: 5, split: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--types') a.types = argv[++i].split(',').map((s) => s.trim());
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--format') a.format = argv[++i];
    else if (k === '--concurrency') a.concurrency = parseInt(argv[++i], 10) || 5;
    else if (k === '--split') a.split = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  const targets = args.types && args.types.length
    ? args.types.filter((t) => TYPES[t])
    : Object.keys(TYPES);

  if (!targets.length) {
    console.error('유효한 상품구분이 없습니다. 사용 가능:', Object.keys(TYPES).join(', '));
    process.exit(1);
  }
  fs.mkdirSync(args.out, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const all = [];
  const summary = [];

  for (const type of targets) {
    const { categoryId } = TYPES[type];
    process.stdout.write(`\n[${type}] 목록 수집 중... `);
    let list = [];
    try {
      list = await fetchTypeList(type, categoryId);
    } catch (e) {
      console.log(`실패 (${e.message}) — 건너뜁니다`);
      summary.push({ type, regions: 0, goods: 0, note: '목록 수집 실패' });
      continue;
    }
    process.stdout.write(`${list.length}개 상품\n`);
    if (!list.length) {
      summary.push({ type, regions: 0, goods: 0, note: '상품 없음' });
      continue;
    }

    let done = 0;
    const records = await mapLimit(list, args.concurrency, async (row) => {
      const rec = await enrich(row);
      done++;
      process.stdout.write(`\r[${type}] 상세 수집 ${done}/${list.length}`);
      return rec;
    });
    process.stdout.write('\n');
    all.push(...records);
    summary.push({
      type,
      regions: new Set(records.map((r) => r.지역명)).size,
      goods: records.length,
      note: '',
    });

    if (args.split && (args.format === 'csv' || args.format === 'both')) {
      const f = path.join(args.out, `prizm_해외_${type}_${stamp}.csv`);
      fs.writeFileSync(f, toCSV(records));
      console.log(`  → 상품구분별 저장: ${f}`);
    }
  }

  if (all.length && (args.format === 'csv' || args.format === 'both')) {
    const base = targets.length === 1 ? targets[0] : '통합';
    const f = path.join(args.out, `prizm_해외_${base}_${stamp}.csv`);
    fs.writeFileSync(f, toCSV(all));
    console.log(`\n통합 CSV 저장: ${f} (${all.length}개 상품)`);
  }
  if (args.format === 'json' || args.format === 'both') {
    const f = path.join(args.out, `prizm_해외_all_${stamp}.json`);
    fs.writeFileSync(f, JSON.stringify(all, null, 2));
    console.log(`통합 JSON 저장: ${f}`);
  }

  console.log('\n───────── 상품구분별 수집 결과 ─────────');
  for (const s of summary) {
    console.log(`  ${s.type.padEnd(6)} 지역 ${String(s.regions).padStart(3)}개 / 상품 ${String(s.goods).padStart(4)}개 ${s.note}`);
  }
  console.log('────────────────────────────────────────');
  console.log(`총 ${all.length}개 상품 / 상품구분 ${targets.length}종`);
}

main().catch((e) => {
  console.error('\n오류:', e.message);
  process.exit(1);
});
