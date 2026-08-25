#!/usr/bin/env node
'use strict';
/**
 * 콘텐츠용 이미지 추천기 — 로컬 웹 서버 (무의존성, Node 18+ 내장 모듈만 사용)
 * -----------------------------------------------------------------------------
 * 정적 프론트(public/) + NAS 프록시/캐시 + AI 추천 API.
 *
 * ⛔ NAS는 읽기 전용. 이 서버는 조회/썸네일/다운로드만 하며 어떤 쓰기도 하지 않는다.
 *
 * 사용법:
 *   1) nas.config.example.json 을 nas.config.json 으로 복사 후 NAS 계정 입력
 *   2) (AI 추천 쓸 경우) ai.config.json 또는 nas.config.json 에 apiKey 입력
 *   3) node server.js  →  http://localhost:8787
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Synology, isImage } = require('./synology');
const content = require('./content');
const { recommend } = require('./recommend');
const { exportCandidates } = require('./exporter');

const DIR = __dirname;
const PUBLIC = path.join(DIR, 'public');
const THUMB_CACHE = path.join(DIR, '.thumbcache');
const EXPORTS = path.join(DIR, 'exports');
const PORT = process.env.PORT || 8787;

// ── 설정 로드 ────────────────────────────────────────────────────────────────
function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  } catch {
    return null;
  }
}
const nasCfg = loadJson('nas.config.json');
const aiCfg = loadJson('ai.config.json') || {};

if (!nasCfg) {
  console.error(
    '\n[설정 없음] nas.config.json 이 없습니다.\n' +
      '  nas.config.example.json 을 nas.config.json 으로 복사한 뒤 NAS 계정을 입력하세요.\n' +
      '  (호텔 목록/콘텐츠 파싱 UI는 뜨지만, NAS 이미지 조회는 로그인 후 동작합니다.)\n'
  );
}

const syno = nasCfg ? new Synology(nasCfg) : null;
const rawApiKey = (aiCfg.apiKey || (nasCfg && nasCfg.apiKey) || process.env.ANTHROPIC_API_KEY || '').trim();
// 실제 키(ASCII, sk- 로 시작)만 인정. 예시 문구("여기에_...") 같은 한글/빈값은 미설정으로 처리
// (그대로 두면 한글이 HTTP 헤더에 들어가 ByteString 오류가 남)
const apiKey = /^sk-[\x21-\x7e]+$/.test(rawApiKey) ? rawApiKey : '';
if (rawApiKey && !apiKey) {
  console.warn('[AI] ai.config.json 의 apiKey 가 실제 키가 아닙니다(예시 문구 등). API 자동추천은 비활성화합니다.');
}
const aiModel = aiCfg.model || (nasCfg && nasCfg.aiModel) || 'claude-opus-5';

if (!fs.existsSync(THUMB_CACHE)) fs.mkdirSync(THUMB_CACHE, { recursive: true });

// ── 유틸 ─────────────────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(s);
}
function sendErr(res, code, message) {
  sendJson(res, code, { error: message });
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC)) return sendErr(res, 403, 'forbidden');
  fs.readFile(filePath, (err, buf) => {
    if (err) return sendErr(res, 404, 'not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// 썸네일 디스크 캐시 키 = 경로+mtime+size 해시
function thumbCachePath(filePath, size, mtime) {
  const h = crypto.createHash('sha1').update(`${filePath}|${size}|${mtime || ''}`).digest('hex');
  return path.join(THUMB_CACHE, `${h}.img`);
}

function requireSyno(res) {
  if (!syno) {
    sendErr(res, 503, 'NAS 미설정: nas.config.json 을 작성한 뒤 서버를 재시작하세요.');
    return false;
  }
  return true;
}

// ── 라우팅 ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;

  try {
    // 정적
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p);

    // 호텔 목록 (NAS 불필요)
    if (p === '/api/hotels') {
      return sendJson(res, 200, { hotels: content.loadHotels(), aiEnabled: !!apiKey });
    }

    // 콘텐츠 파일 목록 / 파싱 (NAS 불필요)
    if (p === '/api/contents') {
      const file = u.searchParams.get('file');
      if (file) return sendJson(res, 200, content.parseContentFile(file));
      return sendJson(res, 200, { files: content.listContentFiles() });
    }

    // 호텔 → 저해상 폴더 해석 + 이미지 목록 (root 지정 시 그 폴더 기준)
    if (p === '/api/images') {
      if (!requireSyno(res)) return;
      const hotel = u.searchParams.get('hotel');
      const fresh = u.searchParams.get('fresh') === '1';
      const root = u.searchParams.get('root') || null;
      if (!hotel) return sendErr(res, 400, 'hotel 파라미터 필요');
      const resolved = await syno.resolveHotelImageDir(hotel, { useCache: !fresh && !root, root });
      // 카테고리 폴더까지 재귀로 이미지 취합(파일명이 무의미해도 폴더명으로 분류)
      const images = await syno.listImagesRecursive(resolved.imageDir);
      return sendJson(res, 200, { ...resolved, count: images.length, images });
    }

    // 호텔 후보 폴더만(“혹시 이 폴더?” 목록)
    if (p === '/api/candidates') {
      if (!requireSyno(res)) return;
      const hotel = u.searchParams.get('hotel');
      if (!hotel) return sendErr(res, 400, 'hotel 파라미터 필요');
      const cands = await syno.collectRootCandidates(hotel);
      return sendJson(res, 200, {
        hotel,
        candidates: cands.slice(0, 12).map((c) => ({ name: c.name, path: c.path, score: Math.round(c.score * 100) / 100, parent: c.parent })),
      });
    }

    // 폴더 트리(수동 드릴다운) — dir | all
    if (p === '/api/tree') {
      if (!requireSyno(res)) return;
      const dirPath = u.searchParams.get('path');
      if (!dirPath) {
        const shares = await syno.listShares();
        return sendJson(res, 200, { shares: shares.map((s) => ({ name: s.name, path: s.path })) });
      }
      const files = await syno.list(dirPath, { onlyDirs: false });
      return sendJson(res, 200, {
        path: dirPath,
        dirs: files.filter((f) => f.isdir).map((f) => ({ name: f.name, path: f.path })),
        imageCount: files.filter((f) => !f.isdir && isImage(f.name)).length,
      });
    }

    // 특정 폴더의 이미지 목록(수동 오버라이드용)
    if (p === '/api/list-images') {
      if (!requireSyno(res)) return;
      const dirPath = u.searchParams.get('path');
      if (!dirPath) return sendErr(res, 400, 'path 필요');
      const images = await syno.listImagesRecursive(dirPath);
      return sendJson(res, 200, { path: dirPath, count: images.length, images });
    }

    // 썸네일 프록시(+디스크 캐시)
    if (p === '/api/thumb') {
      if (!requireSyno(res)) return;
      const filePath = u.searchParams.get('path');
      const size = u.searchParams.get('size') || 'small';
      const mtime = u.searchParams.get('mtime') || '';
      if (!filePath) return sendErr(res, 400, 'path 필요');
      const cacheFile = thumbCachePath(filePath, size, mtime);
      if (fs.existsSync(cacheFile)) {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' });
        return fs.createReadStream(cacheFile).pipe(res);
      }
      const r = await syno.thumb(filePath, size);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFile(cacheFile, buf, () => {});
      res.writeHead(200, {
        'content-type': r.headers.get('content-type') || 'image/jpeg',
        'cache-control': 'max-age=86400',
      });
      return res.end(buf);
    }

    // 원본 다운로드(사용자가 선택 시에만)
    if (p === '/api/original') {
      if (!requireSyno(res)) return;
      const filePath = u.searchParams.get('path');
      if (!filePath) return sendErr(res, 400, 'path 필요');
      const r = await syno.download(filePath);
      const buf = Buffer.from(await r.arrayBuffer());
      const name = path.basename(filePath);
      res.writeHead(200, {
        'content-type': r.headers.get('content-type') || 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      return res.end(buf);
    }

    // Claude에게 보내기: 후보 썸네일을 로컬 exports/ 로 저장 (API 키 불필요)
    // 단일: {hotel, paths[]} / 다중 큐레이션: {label, hotels[], items:[{path,hotel,folder}]}
    if (p === '/api/export' && req.method === 'POST') {
      if (!requireSyno(res)) return;
      const { hotel, label, hotels, theme, body, paths = [], items = null, root = null, limit = 60 } = JSON.parse(await readBody(req));
      if (!hotel && !(items && items.length)) return sendErr(res, 400, 'hotel 또는 items 필요');
      fs.mkdirSync(EXPORTS, { recursive: true });
      const out = await exportCandidates({
        syno, hotel, label, hotels, theme, body, root,
        items: items && items.length ? items.slice(0, limit) : paths.length ? paths.slice(0, limit).map((pp) => ({ path: pp, hotel })) : null,
        limit, size: 'large', outRoot: EXPORTS,
      });
      return sendJson(res, 200, { dir: out.dir, count: out.count, label: out.label });
    }

    // (선택) API 키 기반 자동 추천 — 키가 설정된 경우에만 동작
    if (p === '/api/recommend' && req.method === 'POST') {
      if (!requireSyno(res)) return;
      if (!apiKey) return sendErr(res, 400, 'AI 미설정: ai.config.json 에 apiKey를 넣어주세요.');
      const { hotel, theme, body, paths = [], topN = 8 } = JSON.parse(await readBody(req));
      if (!paths.length) return sendErr(res, 400, '후보 이미지 경로(paths)가 필요합니다.');
      // 후보 썸네일을 base64로 (large — Synology medium은 BMP 버그라 사용 불가)
      const limited = paths.slice(0, 30); // 과도한 토큰/비용 방지
      const candidates = [];
      for (const fp of limited) {
        try {
          const r = await syno.thumb(fp, 'large');
          const b64 = Buffer.from(await r.arrayBuffer()).toString('base64');
          candidates.push({ name: path.basename(fp), path: fp, base64: b64 });
        } catch (e) {
          // 개별 실패는 건너뜀
        }
      }
      const out = await recommend({ apiKey, model: aiModel, hotel, theme, body, candidates, topN });
      return sendJson(res, 200, out);
    }

    return sendErr(res, 404, 'unknown endpoint');
  } catch (e) {
    console.error('[api error]', p, e.message);
    return sendErr(res, 500, e.message || 'internal error');
  }
});

server.listen(PORT, () => {
  console.log(`\n▶ 이미지 추천기: http://localhost:${PORT}`);
  console.log(`  NAS: ${nasCfg ? `${nasCfg.host}:${nasCfg.port || 5000} (읽기 전용)` : '미설정'}`);
  console.log(`  AI 추천: ${apiKey ? `사용 가능 (${aiModel})` : '미설정'}\n`);
});
