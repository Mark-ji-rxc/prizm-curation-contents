'use strict';
// ── 백오피스 게시글 목록 조회(캘린더용) ───────────────────────────────────────
// 로그인 세션(office-session.json)의 JWT를 그대로 authorization 헤더로 써서
// manager API의 게시글 검색을 호출한다. (Bearer 접두어 없이 raw 토큰)
const fs = require('fs');
const CFG = require('./_officecfg');

// baseUrl(웹) → API 호스트 유추: manager-office-stage → manager-office-api-stage
function apiBase() {
  const web = CFG.baseUrl || 'https://manager-office-stage.prizm.co.kr';
  try { const u = new URL(web); return u.origin.replace('manager-office-', 'manager-office-api-'); }
  catch { return 'https://manager-office-api-stage.prizm.co.kr'; }
}
function readToken() {
  if (!fs.existsSync(CFG.sessionFile)) throw new Error('로그인 세션 없음 — 터미널에서 `node publish-login.js` 로 로그인하세요.');
  const s = JSON.parse(fs.readFileSync(CFG.sessionFile, 'utf8'));
  const o = (s.origins || [])[0] || {};
  const t = (o.localStorage || []).find((x) => x.name === 'token');
  if (!t || !t.value) throw new Error('세션에 토큰이 없습니다 — 다시 로그인하세요.');
  return t.value;
}
const CAT = { DOMESTIC: 'domestic', INTERNATIONAL: 'overseas', NONE: 'common' };

// 전체 게시글을 정규화해 반환. [{id, category, title, publisher, start(ms), end(ms|null), status}]
async function fetchOfficePosts() {
  const token = readToken();
  const base = apiBase();
  const headers = { 'content-type': 'application/json', authorization: token, accept: 'application/json' };
  const size = 200;
  let page = 1, out = [], totalPages = 1;
  do {
    const url = `${base}/manager/discover/post/search?page=${page}&size=${size}`;
    const r = await fetch(url, { method: 'POST', headers, body: '{}' });
    if (r.status === 401 || r.status === 403) throw new Error('세션 만료/권한 없음 — 터미널에서 `node publish-login.js` 로 다시 로그인하세요.');
    if (!r.ok) throw new Error('게시글 조회 실패 HTTP ' + r.status);
    const j = await r.json();
    totalPages = j.totalPages || 1;
    for (const p of (j.content || [])) {
      out.push({
        id: p.id,
        category: CAT[p.discoverCategoryType] || 'common',
        title: p.title || '',
        publisher: (p.publisherNames && p.publisherNames[0]) || '',
        start: p.displayStartDate || null,
        end: p.displayEndDate || null,
        status: p.status || '', // PUBLIC / PRIVATE
      });
    }
    page++;
  } while (page <= totalPages);
  return out;
}

module.exports = { fetchOfficePosts };
