'use strict';
/**
 * 콘텐츠/호텔 입력 파서 (무의존성)
 * -----------------------------------------------------------------------------
 * - prizm_all_*.json 에서 호텔 목록(지역 포함) 로드
 * - 큐레이션 콘텐츠 md 파싱: "## 주제/제목" 블록별로 (제목, 본문, 매칭 호텔) 추출
 *   지원 형식:
 *   (1) 큐레이션_콘텐츠_서울_2026-07.md : `## 주제 N.` + 표(| 호텔 | 상품명 |) + `### N-M.` 본문
 *   (2) 콘텐츠 작성/..._30주제.md      : `## N. 주제` + `- 호텔 — 상품 | 가격 | url` 목록 + 본문
 */

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..'); // contetents maker/

// ── 호텔 목록 ────────────────────────────────────────────────────────────────
function findHotelJson() {
  const files = fs
    .readdirSync(PROJECT_DIR)
    .filter((f) => /^prizm_all_\d+\.json$/.test(f))
    .sort();
  return files.length ? path.join(PROJECT_DIR, files[files.length - 1]) : null;
}

function loadHotels() {
  const jsonPath = findHotelJson();
  if (!jsonPath) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return [];
  }
  const byHotel = new Map();
  for (const row of data) {
    const name = row['호텔명'];
    if (!name) continue;
    if (!byHotel.has(name)) {
      byHotel.set(name, { hotel: name, region: row['지역'] || '', productCount: 0 });
    }
    byHotel.get(name).productCount++;
  }
  return [...byHotel.values()].sort((a, b) =>
    a.region === b.region ? a.hotel.localeCompare(b.hotel, 'ko') : a.region.localeCompare(b.region, 'ko')
  );
}

// ── 콘텐츠 md 목록 ───────────────────────────────────────────────────────────
function listContentFiles() {
  const out = [];
  const scan = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (/^(node_modules|\.|검색결과|image-picker)/.test(e.name)) continue;
        scan(abs, r);
      } else if (/큐레이션.*콘텐츠.*\.md$|콘텐츠.*\.md$/.test(e.name)) {
        out.push({ file: r, name: e.name });
      }
    }
  };
  scan(PROJECT_DIR, '');
  return out;
}

// ── md 파싱 ──────────────────────────────────────────────────────────────────
const HOTEL_STOPWORDS = /^(호텔|상품명?|판매가|조식|링크|구성|판매\s?상태|형|화자)$/;

function extractHotelsFromBlock(block) {
  const hotels = new Set();
  // (1) 표 행: | 호텔명 | ... |  → 첫 셀
  for (const m of block.matchAll(/^\|\s*([^|]+?)\s*\|/gm)) {
    const cell = m[1].trim();
    if (!cell || /^-+$/.test(cell) || HOTEL_STOPWORDS.test(cell)) continue;
    // 표 헤더 구분선(---) 및 헤더 라벨 제외
    if (/^[-:\s]+$/.test(cell)) continue;
    hotels.add(cell);
  }
  // (2) 목록: - 호텔명 — 상품명 ...  (— 또는 - 구분)
  for (const m of block.matchAll(/^\s*[-*]\s+(.+?)\s+[—–]\s+/gm)) {
    hotels.add(m[1].trim());
  }
  return [...hotels].filter((h) => h.length >= 2 && h.length <= 40);
}

function stripMarkup(text) {
  return text
    .replace(/^\s*\|.*\|\s*$/gm, '') // 표 라인 제거
    .replace(/^\s*[-*]\s+.+?[—–]\s+.*$/gm, '') // 매칭목록 라인 제거
    .replace(/^\s{0,3}#{1,6}\s.*$/gm, '') // 헤딩 제거
    .replace(/^\s*>.*$/gm, '') // 인용 제거
    .replace(/\*\*(.+?)\*\*/g, '$1') // 볼드 제거
    .replace(/<\/?[^>]+>/g, '') // html 태그 제거
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 링크 텍스트만
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * md 텍스트 → 주제 블록 배열
 * 각 블록: { title, level, body, hotels[] }
 * 최상위 주제(## )와 하위 편(### )을 모두 항목으로 낸다. 하위 편은 상위 주제의
 * 호텔을 상속한다.
 */
function parseContentMarkdown(md) {
  const lines = md.split(/\r?\n/);
  // 헤딩 인덱스 수집
  const heads = [];
  lines.forEach((ln, i) => {
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(ln);
    if (m) heads.push({ i, level: m[1].length, title: m[2].replace(/`[^`]*`/g, '').trim() });
  });
  const items = [];
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h].i;
    const end = h + 1 < heads.length ? heads[h + 1].i : lines.length;
    const block = lines.slice(start, end).join('\n');
    const hotels = extractHotelsFromBlock(block);
    const body = stripMarkup(lines.slice(start + 1, end).join('\n'));
    items.push({ title: heads[h].title, level: heads[h].level, hotels, body });
  }
  // 하위 편에 상위 주제 호텔 상속
  let lastL2Hotels = [];
  for (const it of items) {
    if (it.level === 2) lastL2Hotels = it.hotels;
    else if (it.level === 3 && it.hotels.length === 0) it.hotels = lastL2Hotels;
  }
  // 제목/본문 둘 다 비어있는 항목 제거
  return items.filter((it) => it.title && (it.body || it.hotels.length));
}

function parseContentFile(relFile) {
  const abs = path.join(PROJECT_DIR, relFile);
  const md = fs.readFileSync(abs, 'utf8');
  return { file: relFile, items: parseContentMarkdown(md) };
}

module.exports = {
  PROJECT_DIR,
  loadHotels,
  listContentFiles,
  parseContentFile,
  parseContentMarkdown,
  extractHotelsFromBlock,
};
