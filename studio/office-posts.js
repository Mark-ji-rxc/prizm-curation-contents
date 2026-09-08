'use strict';
// ── 백오피스 게시글 목록 조회(캘린더용) ───────────────────────────────────────
// 로그인 세션(office-session.json)의 JWT를 그대로 authorization 헤더로 써서
// manager API의 게시글 검색을 호출한다. (Bearer 접두어 없이 raw 토큰)
const fs = require('fs');
const CFG = require('./_officecfg');

function readToken(off) {
  const envKo = off.env === 'prod' ? '프로덕션' : '스테이지';
  const cmd = 'node publish-login.js' + (off.env === 'prod' ? ' prod' : '');
  if (!fs.existsSync(off.sessionFile)) throw new Error(`${envKo} 로그인 세션 없음 — 터미널에서 \`${cmd}\` 로 로그인하세요.`);
  const s = JSON.parse(fs.readFileSync(off.sessionFile, 'utf8'));
  const o = (s.origins || [])[0] || {};
  const t = (o.localStorage || []).find((x) => x.name === 'token');
  if (!t || !t.value) throw new Error(`${envKo} 세션에 토큰이 없습니다 — 다시 로그인하세요.`);
  return t.value;
}
const CAT = { DOMESTIC: 'domestic', INTERNATIONAL: 'overseas', NONE: 'common' };

// 전체 게시글을 정규화해 반환. env: 'stage'(기본) | 'prod'. [{id, category, title, publisher, start(ms), end(ms|null), status}]
async function fetchOfficePosts(env) {
  const off = CFG.envConfig(env);
  const token = readToken(off);
  const base = off.apiBase;
  const headers = { 'content-type': 'application/json', authorization: token, accept: 'application/json' };
  const size = 200;
  let page = 1, out = [], totalPages = 1;
  do {
    const url = `${base}/manager/discover/post/search?page=${page}&size=${size}`;
    const r = await fetch(url, { method: 'POST', headers, body: '{}' });
    if (r.status === 401 || r.status === 403) throw new Error(`${off.env === 'prod' ? '프로덕션' : '스테이지'} 세션 만료/권한 없음 — 터미널에서 \`node publish-login.js${off.env === 'prod' ? ' prod' : ''}\` 로 다시 로그인하세요.`);
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

// 로그인 세션(JWT) 만료 정보 — 네트워크 없이 로컬 토큰만 디코드. 만료 임박 경고용.
function decodeExp(token) { try { const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()); return p.exp ? p.exp * 1000 : null; } catch { return null; } }
// 발행 주체용 프로필 목록. GET {apiBase}/manager/discover/post/profile → [{id, nickname, ...}]
async function fetchProfiles(env) {
  const off = CFG.envConfig(env);
  const token = readToken(off);
  const r = await fetch(off.apiBase + '/manager/discover/post/profile', { headers: { authorization: token, accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) throw new Error(`${off.env === 'prod' ? '프로덕션' : '스테이지'} 세션 만료/권한 없음 — 다시 로그인하세요.`);
  if (!r.ok) throw new Error('프로필 조회 실패 HTTP ' + r.status);
  const j = await r.json();
  const arr = Array.isArray(j) ? j : (j.content || j.data || []);
  return arr.map((p) => ({ id: p.id, nickname: p.nickname || p.name || '' })).filter((p) => p.nickname);
}
function sessionInfo(env) {
  const off = CFG.envConfig(env);
  try {
    const token = readToken(off);
    const exp = decodeExp(token); const now = Date.now();
    return { exists: true, env: off.env, exp, expired: exp != null && exp < now, expiresInMs: exp != null ? exp - now : null };
  } catch (e) { return { exists: false, env: off.env, error: e.message }; }
}

module.exports = { fetchOfficePosts, sessionInfo, fetchProfiles };
