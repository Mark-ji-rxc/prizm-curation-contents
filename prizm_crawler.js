#!/usr/bin/env node
/**
 * PRIZM 지역별 상품 크롤러
 * -----------------------------------------------------------------------------
 * PRIZM 모바일웹(mweb.prizm.co.kr)의 내부 REST API를 직접 호출해
 * 지역별 호텔·상품 데이터를 수집하고 CSV / JSON 으로 저장한다.
 *
 * 브라우저 없이 순수 HTTP 로 동작 (핵심: X-PRIZM-CHANNEL: MWEB 헤더).
 *
 * 요구사항: Node.js 18+ (내장 fetch 사용, 외부 의존성 없음)
 *
 * 사용법:
 *   node prizm_crawler.js                     # 전체 지역, CSV+JSON 저장
 *   node prizm_crawler.js --regions 서울,제주   # 특정 지역만
 *   node prizm_crawler.js --out ./output       # 출력 폴더 지정
 *   node prizm_crawler.js --format csv         # csv | json | both(기본)
 *   node prizm_crawler.js --concurrency 4      # 상세조회 동시 요청 수(기본 4)
 *
 * 산출물: {out}/prizm_{지역}_{YYYYMMDD}.csv  및  ..._all_{YYYYMMDD}.json
 * -----------------------------------------------------------------------------
 */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── 설정 ─────────────────────────────────────────────────────────────────────
const API = 'https://api.prizm.co.kr';
const WEB = 'https://mweb.prizm.co.kr';

// 지역 → categoryId (2026-07 기준). 변경 시 홈에서 지역 링크 href의 숫자로 갱신.
const REGIONS = {
  '서울': 21233,
  '제주': 21234,
  '부산': 21235,
  '강원': 21236,
  '경기·인천': 21237,
  '경상': 21238,
  '전라': 21239,
  '충청': 21240,
};

// 앱이 붙이는 필수 헤더. 토큰은 비로그인 상태에서 빈 값으로 동작.
const HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'X-PRIZM-CHANNEL': 'MWEB',
  'X-PRIZM-TOKEN': '',
  'X-PRIZM-DEVICE-ID': crypto.randomUUID(),
  'user-agent': 'Mozilla/5.0 (prizm-crawler)',
  'origin': WEB,
  'referer': WEB + '/',
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

// 간단한 동시성 제한 map
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

// ── 목록 수집 (지역 카테고리, 페이지네이션 포함) ─────────────────────────────
async function fetchRegionList(regionName, categoryId) {
  const rows = [];
  const seen = new Set();
  let offset = null;
  // nextParameter 예: "offset=8" → 다음 페이지 존재
  for (let page = 0; page < 50; page++) {
    const qs = offset != null ? `?${offset}` : '?';
    const j = await getJSON(`${API}/v1/discover/category/${categoryId}/brand-goods${qs}`);
    const content = (j && j.content) || [];
    if (!content.length) break;
    for (const b of content) {
      const sr = b.showRoom || {};
      const addr = (sr.tags || []).find((t) => t.type === 'ADDRESS')?.value || '';
      const cat = (sr.tags || []).find((t) => t.type === 'TAG')?.value || '';
      for (const gl of b.goodsList || []) {
        const g = gl.goods;
        if (!g || seen.has(g.code)) continue;
        seen.add(g.code);
        rows.push({
          region: regionName,
          numId: g.id,
          showRoomId: g.showRoomId,
          code: g.code,
          hotel: sr.name || b.title,
          address: addr,
          category: cat,
          name: (g.name || '').trim(),
          price: g.price,
          consumerPrice: g.consumerPrice,
          discountRate: g.discountRate,
          nights: (g.itinerary && g.itinerary.displayText) || '',
          salesStart: g.salesStartDate,
          salesEnd: g.salesEndDate,
          status: g.status,
        });
      }
    }
    if (!j.nextParameter) break;
    offset = j.nextParameter; // 예: "offset=8"
    await sleep(120);
  }
  return rows;
}

// ── 상세 수집 & 가공 ─────────────────────────────────────────────────────────
async function enrich(row) {
  const now = Date.now();
  let detail = {};
  try {
    detail = await getJSON(`${API}/v1/goods/${row.numId}/showroom/${row.showRoomId}`);
  } catch (e) {
    detail = {};
  }

  const kp = (detail.keyPoints && detail.keyPoints.items) || [];
  const pkgItems = kp.filter((x) => x.titleType !== 'GUEST_COUNT');
  const guest = kp.find((x) => x.titleType === 'GUEST_COUNT');
  const pkg = pkgItems.map((x) => `[${x.title}]\n${x.contents}`).join('\n\n');

  // 투숙인원 기준/최대
  let base = '', max = '';
  if (guest) {
    guest.contents.split('\n').forEach((l) => {
      l = l.trim();
      if (/^기준/.test(l)) base = l.replace(/^기준\s*[:：]?\s*/, '').trim();
      if (/^최대/.test(l)) max = l.replace(/^최대\s*[:：]?\s*/, '').trim();
    });
  }
  const rm = detail.accomTop && detail.accomTop.rooms && detail.accomTop.rooms[0];
  if (!base && rm && rm.stdPersonsText) base = rm.stdPersonsText.replace(/^기준\s*/, '');
  if (!max && rm && rm.maxPersonsText) max = rm.maxPersonsText.replace(/^최대\s*/, '');

  const tk = detail.ticket || {};
  // 호텔명: 기본은 목록의 showRoom.name(사이트 표기와 동일).
  // 단 "그랜드머큐어임피리얼팰리스강남"처럼 공백 없이 붙어 나오는 경우가 있어,
  // 그럴 때만 상세의 brand.name(띄어쓰기 정상)으로 보정한다.
  const brandName = (detail.brand && (detail.brand.name || detail.brand.title)) || '';
  const hotel =
    row.hotel && !/\s/.test(row.hotel) && /\s/.test(brandName) ? brandName : (row.hotel || brandName);
  const stayPeriod = tk.usablePeriodText || '';
  const checkIn = (tk.checkInOut && tk.checkInOut.checkIn) || (detail.accomTop && detail.accomTop.checkInTime) || '';
  const checkOut = (tk.checkInOut && tk.checkInOut.checkOut) || (detail.accomTop && detail.accomTop.checkOutTime) || '';

  const ss = detail.salesStartDate ?? row.salesStart;
  const se = detail.salesEndDate ?? row.salesEnd;
  const salePeriod = se ? `${fmtDate(ss)} - ${fmtDate(se)}` : '상시판매';

  // 매진 여부: 상세 API가 진짜 출처.
  //   TICKET_RUNOUT / statusText="매진" / isRunOut=true / isBuyAble=false
  //   ⚠️ 목록 API의 status·isRunOut은 매진이어도 NORMAL/false로 오므로 믿으면 안 된다.
  const isRunOut =
    detail.isRunOut === true ||
    detail.status === 'TICKET_RUNOUT' ||
    detail.statusText === '매진';

  // 판매상태: 상세 status 우선(WAIT=판매예정, TICKET_RUNOUT=매진), 없으면 판매시작일로 판단.
  const saleStatus = isRunOut
    ? '매진'
    : detail.status === 'WAIT' || (ss && ss > now)
    ? '판매예정'
    : '판매중';

  // 플래그 (상품명 + 패키지 텍스트 기준, 공백 제거 후 매칭)
  const blob = (row.name + ' ' + pkg).replace(/\s/g, '');
  const lounge = /라운지/.test(blob);
  const breakfast = /조식|모닝|브렉퍼스트|아침식사/.test(blob);
  const dinner = /디너|석식/.test(blob);
  const goods = /인형|텀블러|안마기기|마사지기|굿즈|어메니티|스킨케어|이너뷰티|뷰티PKG|키트|피규어/.test(blob);

  const flag = (b) => (b ? 'O' : '');

  return {
    지역: row.region,
    호텔명: hotel,
    호텔유형: row.category || '', // 쇼룸 TAG (프리미엄 호텔·프리미엄 리조트·라이프스타일 호텔 등)
    상품ID: row.numId,   // 내부 상품 식별자(숫자 5~6자리). 등록/API 매칭용.
    상품코드: row.code,  // 상품 URL(/goods/<코드>)에 쓰이는 영문 코드.
    상품명: row.name,
    박수: row.nights,
    '판매가(원)': row.price,
    '정가(원)': row.consumerPrice,
    '할인율(%)': row.discountRate,
    판매상태: saleStatus,
    매진: flag(isRunOut),
    판매기간: salePeriod,
    판매시작일: ss ? new Date(ss).toISOString().slice(0, 10) : '',
    판매종료일: se ? new Date(se).toISOString().slice(0, 10) : '', // 상시판매면 빈 값
    투숙가능기간: stayPeriod,
    '투숙인원(기준)': base,
    '투숙인원(최대)': max,
    체크인: checkIn,
    체크아웃: checkOut,
    '레이트 체크아웃': flag(/레이트체크아웃|늦은체크아웃/.test(blob) || /\d+시레이트체크아웃/.test(blob)),
    '레이트 체크인': flag(/레이트체크인/.test(blob)),
    '24시간 스테이': flag(/24시간스테이/.test(blob)),
    '인원추가비 무료(최대인원까지)': flag(/인원추가비용무료|인원추가비무료|인원추가무료|최대인원까지인원추가/.test(blob)),
    조식: flag(breakfast && !lounge), // 라운지+조식 → 라운지로만
    디너: flag(dinner),
    라운지: flag(lounge),
    '굿즈 제공': flag(goods),
    '패키지 포함내역': pkg,
    '상품 URL': `${WEB}/goods/${row.code}`,
  };
}

const COLUMNS = [
  '지역', '호텔명', '호텔유형', '상품ID', '상품코드', '상품명', '박수', '판매가(원)', '정가(원)', '할인율(%)',
  '판매상태', '매진', '판매기간', '판매시작일', '판매종료일', '투숙가능기간', '투숙인원(기준)', '투숙인원(최대)',
  '체크인', '체크아웃', '레이트 체크아웃', '레이트 체크인', '24시간 스테이',
  '인원추가비 무료(최대인원까지)', '조식', '디너', '라운지', '굿즈 제공',
  '패키지 포함내역', '상품 URL',
];

function toCSV(records) {
  const lines = [COLUMNS.map(csvEscape).join(',')];
  for (const r of records) lines.push(COLUMNS.map((c) => csvEscape(r[c])).join(','));
  return '﻿' + lines.join('\n'); // BOM: Excel 한글 깨짐 방지
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { regions: null, out: '검색결과', format: 'both', concurrency: 4, split: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--regions') a.regions = argv[++i].split(',').map((s) => s.trim());
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--format') a.format = argv[++i];
    else if (k === '--concurrency') a.concurrency = parseInt(argv[++i], 10) || 4;
    else if (k === '--split') a.split = true; // 지역별 CSV를 따로 저장(기본은 통합 1개)
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  const targets = args.regions && args.regions.length
    ? args.regions.filter((r) => REGIONS[r])
    : Object.keys(REGIONS);

  if (!targets.length) {
    console.error('유효한 지역이 없습니다. 사용 가능:', Object.keys(REGIONS).join(', '));
    process.exit(1);
  }
  fs.mkdirSync(args.out, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const all = [];
  const summary = [];

  for (const region of targets) {
    const cid = REGIONS[region];
    process.stdout.write(`\n[${region}] 목록 수집 중... `);
    let list = [];
    try {
      list = await fetchRegionList(region, cid);
    } catch (e) {
      console.log(`실패 (${e.message}) — 건너뜁니다`);
      summary.push({ region, hotels: 0, goods: 0, note: '목록 수집 실패' });
      continue;
    }
    process.stdout.write(`${list.length}개 상품\n`);
    if (!list.length) {
      summary.push({ region, hotels: 0, goods: 0, note: '상품 없음' });
      continue;
    }

    let done = 0;
    const records = await mapLimit(list, args.concurrency, async (row) => {
      const rec = await enrich(row);
      done++;
      process.stdout.write(`\r[${region}] 상세 수집 ${done}/${list.length}`);
      return rec;
    });
    process.stdout.write('\n');
    all.push(...records);
    summary.push({
      region,
      hotels: new Set(records.map((r) => r.호텔명)).size,
      goods: records.length,
      note: '',
    });

    // --split 을 준 경우에만 지역별 CSV를 따로 저장
    if (args.split && (args.format === 'csv' || args.format === 'both')) {
      const f = path.join(args.out, `prizm_${region}_${stamp}.csv`);
      fs.writeFileSync(f, toCSV(records));
      console.log(`  → 지역별 저장: ${f}`);
    }
  }

  // 통합 CSV 1개로 저장 (기본 동작). 지역이 1개면 그 지역명으로, 여러 개면 '통합'.
  if (all.length && (args.format === 'csv' || args.format === 'both')) {
    const base = targets.length === 1 ? targets[0] : '통합';
    const f = path.join(args.out, `prizm_${base}_${stamp}.csv`);
    fs.writeFileSync(f, toCSV(all));
    console.log(`\n통합 CSV 저장: ${f} (${all.length}개 상품)`);
  }
  if (args.format === 'json' || args.format === 'both') {
    const f = path.join(args.out, `prizm_all_${stamp}.json`);
    fs.writeFileSync(f, JSON.stringify(all, null, 2));
    console.log(`통합 JSON 저장: ${f}`);
  }

  console.log('\n───────── 지역별 수집 결과 ─────────');
  for (const s of summary) {
    console.log(`  ${s.region.padEnd(7)} 호텔 ${String(s.hotels).padStart(3)}개 / 상품 ${String(s.goods).padStart(4)}개 ${s.note}`);
  }
  console.log('────────────────────────────────────');
  console.log(`총 ${all.length}개 상품 / 지역 ${targets.length}개`);
}

main().catch((e) => {
  console.error('\n오류:', e.message);
  process.exit(1);
});
