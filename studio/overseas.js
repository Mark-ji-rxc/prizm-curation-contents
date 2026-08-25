'use strict';
/**
 * 해외(패키지식) 이미지 폴더 리졸버 — 국내와 폴더 구조가 다름.
 * -----------------------------------------------------------------------------
 * 구조: /RXC_V2/업무협업문서함/00_콘텐츠/해외여행_<나라>/[지역별자료]/<도시>/{01_호텔,02_관광지,…}/*
 *  - 지역별자료 폴더명은 제각각(00_지역별자료 / 01_지역별자료 / 01_지역별 자료) → "지역별" 포함으로 탐색.
 *  - 지역별자료가 없으면 나라 폴더 바로 아래에 도시 폴더가 옴.
 *  - 도시 폴더명엔 숫자 접두사가 붙기도 함("1 나트랑", "2 푸꾸옥"). 없기도("기타큐슈").
 *  - 도시 폴더 아래 카테고리(01_호텔/02_관광지 등)의 이미지를 전부 취합.
 *
 * 적용 대상(Case B): 해외 패키지 · 현지투어 · "해외 호텔 중 패키지식(기본정보가 [PKG 혜택]이 아님)".
 * 적용 제외(Case A): 해외 호텔 중 호텔식(기본정보가 [PKG 혜택]) → 국내와 동일하게 호텔명으로 resolveHotelImageDir.
 *
 * ⛔ NAS 읽기 전용. 여기선 list / listImagesRecursive 만 사용.
 */

const fs = require('fs');
const path = require('path');
const { scoreMatch } = require('../image-picker/synology');

const CONTENT_BASE = '/RXC_V2/업무협업문서함/00_콘텐츠';
const INDEX_FILE = path.join(__dirname, 'overseas-city-index.json');

const stripCity = (name) => String(name || '').replace(/^[0-9]+[\s._-]*/, '').replace(/^[①-⑳★☆]+\s*/, '').trim();
const nrm = (s) => String(s || '').toLowerCase().replace(/[\s\-_·,.()\[\]★☆]/g, '');
// 도시가 아닌 폴더(포토/디자인/마케팅/로고/음식 등) 걸러내기
const JUNK = /포토|비디오|에디토리얼|디자인|마케팅|과거|기획전|브랜드|svg|로고|이벤트|항공|비엣젯|하나투어|음식|지역별|stock|자료$|현지투어|투어$|티켓|승선권/i;

// 문자 단위 유사도(레벤슈타인 비율) — "기타규슈"↔"기타큐슈" 같은 1글자 표기차 매칭용
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const charSim = (a, b) => (!a || !b ? 0 : 1 - lev(a, b) / Math.max(a.length, b.length));

// Case A(호텔식) 판별: 해외 호텔 + 기본정보/상세가 [PKG 혜택] 형태
function isHotelStyle(prod) {
  if (!prod || !/호텔/.test(prod.type || '')) return false;
  const txt = (prod.baseInfo || prod.detail || '') + '';
  return /PKG\s*혜택/.test(txt);
}

// 도시/나라 인덱스 구축(1회 스캔 → 캐시). {cities:[{country,city,raw,path}], countries:[{country,base,imgBase}]}
async function buildCityIndex(syno) {
  const countryDirs = (await syno.list(CONTENT_BASE, { onlyDirs: true }))
    .filter((f) => f.isdir && /^해외여행_/.test(f.name));
  const cities = [];
  const countries = [];
  for (const c of countryDirs) {
    const country = c.name.replace(/^해외여행_/, '');
    let l1;
    try { l1 = (await syno.list(c.path, { onlyDirs: true })).filter((f) => f.isdir); } catch { continue; }
    const region = l1.find((f) => /지역별/.test(f.name));
    // 지역별자료가 있으면 그 아래 도시(숫자 접두 OK: "1 나트랑"). 없으면 나라 폴더 바로 아래 — 이때 숫자 접두는 구조폴더(01_포토&비디오 등)라 제외.
    const cityDirs = region
      ? (await syno.list(region.path, { onlyDirs: true }).catch(() => [])).filter((f) => f.isdir)
      : l1.filter((f) => f.isdir && !/^\d/.test(f.name));
    // 나라 단위 폴백 이미지 경로: 지역별자료 폴더(있으면) 우선, 없으면 나라 폴더
    countries.push({ country, base: c.path, imgBase: region ? region.path : c.path });
    for (const cd of cityDirs) {
      if (JUNK.test(cd.name)) continue; // 도시가 아닌 폴더 제외
      const city = stripCity(cd.name);
      if (!city || JUNK.test(city)) continue;
      cities.push({ country, city, raw: cd.name, path: cd.path });
    }
  }
  fs.writeFileSync(INDEX_FILE, JSON.stringify({ builtAt: new Date().toISOString(), cities, countries }, null, 2));
  return { cities, countries };
}

async function getFullIndex(syno, fresh) {
  if (!fresh) {
    try { const j = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); if (j.cities && j.cities.length) return { cities: j.cities, countries: j.countries || [] }; } catch {}
  }
  return buildCityIndex(syno);
}
async function getCityIndex(syno, fresh) { return (await getFullIndex(syno, fresh)).cities; }

// 상품(패키지식) → 도시 폴더 해석. 지역명+상품명 토큰을 도시 폴더명과 매칭.
async function resolveOverseas(syno, prod, { fresh = false } = {}) {
  const { cities, countries } = await getFullIndex(syno, fresh);
  const hay = `${prod.region || ''} ${prod.name || ''}`;
  const hayN = nrm(hay);
  const tokens = [...new Set(hay.split(/[\s\[\]()·,/|~]+/).map(nrm).filter((t) => t.length >= 2))];
  const scored = cities.map((ci) => {
    const cityN = nrm(ci.city);
    // (1) scoreMatch (포함/토큰/LCS/bigram) (2) 도시명이 통째로 들어있으면 강함 (3) 토큰별 문자유사도 최댓값(표기차 흡수)
    let s = scoreMatch(hay, ci.city);
    if (cityN && hayN.includes(cityN)) s = Math.max(s, 0.95);
    const tokSim = tokens.reduce((mx, t) => Math.max(mx, charSim(cityN, t)), 0);
    s = Math.max(s, tokSim >= 0.7 ? tokSim : 0);
    if (hayN.includes(nrm(ci.country))) s += 0.15; // 나라명도 있으면 가점
    return { ci, score: s };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const candidates = scored.slice(0, 5).map((x) => ({ ...x.ci, score: Math.round(x.score * 100) / 100 }));

  if (best && best.score >= 0.5) {
    const images = await syno.listImagesRecursive(best.ci.path);
    return { imageDir: best.ci.path, mode: 'overseas', matched: { ...best.ci, score: Math.round(best.score * 100) / 100 }, count: images.length, images, candidates };
  }
  // 도시 매칭 실패 → 나라 단위 폴백(도시국가·나라 전체 목적지). 나라명이 상품에 있으면 그 나라 이미지 전체 취합.
  const country = countries
    .map((c) => ({ c, s: hayN.includes(nrm(c.country)) ? c.country.length : charSim(nrm(c.country), tokens[0] || '') }))
    .sort((a, b) => b.s - a.s)[0];
  if (country && country.s >= 2) {
    const images = await syno.listImagesRecursive(country.c.imgBase);
    return { imageDir: country.c.imgBase, mode: 'overseas-country', matched: { country: country.c.country, city: '(나라 전체)', path: country.c.imgBase }, count: images.length, images, candidates };
  }
  return { imageDir: null, images: [], mode: 'overseas', matched: null, candidates };
}

module.exports = { CONTENT_BASE, INDEX_FILE, isHotelStyle, buildCityIndex, getCityIndex, resolveOverseas, stripCity };
