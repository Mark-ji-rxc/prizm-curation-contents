'use strict';
/**
 * 크롤러 실행 & 산출물 로더 (무의존성)
 * -----------------------------------------------------------------------------
 * 기존 크롤러 2종을 수정하지 않고 child_process로 실행한다.
 *   - 국내: ../prizm_crawler.js           → 검색결과/prizm_통합_*.csv + prizm_all_*.json
 *   - 해외: ../prizm_overseas_crawler.js   → 검색결과/prizm_해외_통합_*.csv + prizm_해외_all_*.json
 * 실행 후 최신 산출물을 읽어 통합 스튜디오에서 사용한다.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..'); // contents maker/
const OUT_DIR = path.join(PROJECT_DIR, '검색결과');

const CRAWLERS = {
  domestic: { label: '국내', script: 'prizm_crawler.js', jsonPrefix: 'prizm_all_', csvPrefix: 'prizm_통합_' },
  overseas: { label: '해외', script: 'prizm_overseas_crawler.js', jsonPrefix: 'prizm_해외_all_', csvPrefix: 'prizm_해외_통합_' },
};

function latestFile(prefix, ext) {
  let files;
  try { files = fs.readdirSync(OUT_DIR); } catch { return null; }
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + esc + '(\\d{8})\\.' + ext + '$');
  const matched = [];
  for (const f of files) {
    const m = re.exec(f);
    if (m) matched.push({ f, stamp: m[1] });
  }
  if (!matched.length) return null;
  matched.sort((a, b) => a.stamp.localeCompare(b.stamp));
  return matched[matched.length - 1].f;
}

function datasetInfo(source) {
  const c = CRAWLERS[source];
  if (!c) return null;
  const jf = latestFile(c.jsonPrefix, 'json');
  const cf = latestFile(c.csvPrefix, 'csv');
  if (!jf) return null;
  const jsonPath = path.join(OUT_DIR, jf);
  let count = 0;
  try { count = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).length; } catch {}
  let updatedAt = null;
  try { updatedAt = fs.statSync(jsonPath).mtime.toISOString(); } catch {}
  return {
    source, label: c.label,
    jsonFile: jf, csvFile: cf, count, updatedAt,
    jsonPath, csvPath: cf ? path.join(OUT_DIR, cf) : null,
  };
}

function loadItems(source) {
  const info = datasetInfo(source);
  if (!info) return [];
  try { return JSON.parse(fs.readFileSync(info.jsonPath, 'utf8')); } catch { return []; }
}

// 상품ID(숫자 5~6자리)와 상품코드(URL의 영문 goods 코드)를 구분해 추출.
function idOf(r) { // 내부 상품 식별자(숫자). 구버전 데이터엔 없을 수 있음.
  for (const k of ['상품ID', '상품id']) { if (r[k] != null && /^\d+$/.test(String(r[k]))) return String(r[k]); }
  return '';
}
function codeOf(r) { // 상품 URL(/goods/<코드>)의 영문 코드.
  if (r['상품코드']) return String(r['상품코드']);
  const m = /\/goods\/([^/?#]+)/.exec(r['상품 URL'] || '');
  if (m) return m[1];
  for (const k of ['상품ID', '상품id']) { const v = r[k]; if (v && !/^\d+$/.test(String(v))) return String(v); } // 구버전: 코드가 상품ID에 들어있던 경우
  return '';
}
function saleFields(r) {
  const period = r['판매기간'] || '';
  const saleEnd = r['판매종료일'] || '';
  const alwaysOn = period === '상시판매' || (period === '' && !saleEnd);
  return { salePeriod: period, saleStart: r['판매시작일'] || '', saleEnd, alwaysOn };
}

// 국내/해외 레코드를 공통 스키마로 정규화(콘텐츠 매칭·미리보기용)
function normalize(source, r) {
  if (source === 'overseas') {
    return {
      source, productId: idOf(r), productCode: codeOf(r), hotel: r['지역명'] || '', region: r['지역명'] || '', type: r['상품구분'] || '', productType: r['상품구분'] || '',
      name: (r['상품명'] || '').trim(), price: r['판매가(원)'], consumer: r['정가(원)'], discount: r['할인율(%)'],
      nights: r['박수'] || '', status: r['판매상태'] || '', soldout: r['매진'] === 'O',
      ...saleFields(r),
      url: r['상품 URL'] || '',
      flags: {
        객실업그레이드: r['무료 객실 업그레이드'] === 'O', 렌터카: r['렌터카 포함'] === 'O',
        여행자보험: r['여행자 보험 포함'] === 'O', 기프트: r['Gift 제공(망고 등)'] === 'O',
        얼리체크인: r['얼리 체크인'] === 'O', 레이트체크아웃: r['레이트 체크아웃'] === 'O',
        마사지: r['마사지 포함'] === 'O', 국적기: r['국적기 이용 가능'] === 'O',
      },
      baseInfo: r['기본 정보'] || '',
      exclusive: r['단독 구성'] || '',
      detail: [r['기본 정보'], r['단독 구성']].filter(Boolean).join('\n'),
    };
  }
  return {
    source, productId: idOf(r), productCode: codeOf(r), hotel: r['호텔명'] || '', region: r['지역'] || '', type: '국내호텔', productType: r['호텔유형'] || '',
    name: (r['상품명'] || '').trim(), price: r['판매가(원)'], consumer: r['정가(원)'], discount: r['할인율(%)'],
    nights: r['박수'] || '', status: r['판매상태'] || '', soldout: r['매진'] === 'O',
    basePersons: r['투숙인원(기준)'] || '', maxPersons: r['투숙인원(최대)'] || '',
    ...saleFields(r),
    url: r['상품 URL'] || '',
    flags: {
      조식: r['조식'] === 'O', 디너: r['디너'] === 'O', 라운지: r['라운지'] === 'O', 굿즈: r['굿즈 제공'] === 'O',
      레이트체크아웃: r['레이트 체크아웃'] === 'O', 레이트체크인: r['레이트 체크인'] === 'O',
      '24시간': r['24시간 스테이'] === 'O', 인원추가무료: r['인원추가비 무료(최대인원까지)'] === 'O',
    },
    detail: r['패키지 포함내역'] || '',
  };
}

function normalizedItems(source) {
  return loadItems(source).map((r) => normalize(source, r));
}

function runCrawl(source, onLog) {
  return new Promise((resolve, reject) => {
    const c = CRAWLERS[source];
    if (!c) return reject(new Error('unknown source: ' + source));
    onLog(`[${c.label}] 상품 불러오는 중… (${c.script})`);
    const child = spawn('node', [c.script, '--out', '검색결과'], { cwd: PROJECT_DIR });
    const push = (buf) => String(buf).split(/[\r\n]+/).forEach((l) => { const t = l.trim(); if (t) onLog(t); });
    child.stdout.on('data', push);
    child.stderr.on('data', (d) => push('[err] ' + d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) { onLog(`[${c.label}] 완료 ✓`); resolve(datasetInfo(source)); }
      else reject(new Error(`${c.label} 크롤러 종료 코드 ${code}`));
    });
  });
}

module.exports = { PROJECT_DIR, OUT_DIR, CRAWLERS, datasetInfo, loadItems, normalize, normalizedItems, runCrawl };
