'use strict';
/**
 * 후보 썸네일을 로컬 폴더로 내려받아, 여기(Claude Code)가 직접 보고 추천할 수 있게 한다.
 * -----------------------------------------------------------------------------
 * - NAS는 여전히 읽기 전용(Thumb만 읽음). 저장은 이 PC의 exports/ 폴더에만.
 * - 다중 호텔(큐레이션) 지원: 이미지마다 hotel 태그를 파일명/manifest에 기록.
 * - manifest.json: 로컬 파일 → 실제 NAS 경로/호텔/카테고리 매핑.
 * - content.txt: 주제·본문·호텔 목록(추천 판단 컨텍스트).
 * - Synology의 medium 썸네일은 BMP로 내려오는 버그가 있어 'large'(정상 JPEG)를 사용.
 */

const fs = require('fs');
const path = require('path');

function safeName(s) {
  return String(s || '')
    .replace(/[\/\\:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'untitled';
}
function extOrJpg(name) {
  const m = /\.(jpg|jpeg|png|gif|webp)$/i.exec(name || '');
  return m ? m[0].toLowerCase() : '.jpg';
}

/**
 * @param {object} o
 * @param {import('./synology').Synology} o.syno
 * @param {string} [o.hotel]            단일 호텔(items 없을 때 자동 해석용)
 * @param {string} [o.label]            저장 폴더명(다중 호텔이면 주제 등). 없으면 hotel.
 * @param {string} [o.root]             단일 호텔 루트 강제
 * @param {Array<{path,hotel?,folder?}>} [o.items]  내려받을 이미지들(다중 호텔 가능)
 * @param {string} [o.theme]
 * @param {string} [o.body]
 * @param {string[]} [o.hotels]         큐레이션 대상 호텔명들(기록용)
 * @param {string} [o.size='large']
 * @param {number} [o.limit=40]
 * @param {string} o.outRoot
 * @returns {Promise<{dir, count, label, resolved}>}
 */
async function exportCandidates({ syno, hotel = '', label = '', root = null, items = null, theme = '', body = '', hotels = null, size = 'large', limit = 40, outRoot }) {
  let imageObjs = items;
  let resolved = null;
  if (!imageObjs || !imageObjs.length) {
    // 단일 호텔 자동 해석
    resolved = await syno.resolveHotelImageDir(hotel, { root });
    const imgs = await syno.listImagesRecursive(resolved.imageDir);
    imageObjs = imgs.map((i) => ({ path: i.path, hotel, folder: i.folder }));
  }
  imageObjs = imageObjs.slice(0, limit);

  const dirName = safeName(label || hotel || (hotels && hotels[0]) || '큐레이션');
  const dir = path.join(outRoot, dirName);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }

  const manifest = [];
  let idx = 0;
  for (const im of imageObjs) {
    const fp = im.path;
    try {
      const r = await syno.thumb(fp, size);
      const buf = Buffer.from(await r.arrayBuffer());
      const parts = [String(idx).padStart(3, '0')];
      if (im.hotel) parts.push(safeName(im.hotel).slice(0, 24));
      if (im.folder) parts.push(safeName(im.folder).slice(0, 24));
      parts.push(safeName(path.basename(fp).replace(/\.[^.]+$/, '')).slice(0, 30));
      const base = parts.join('__') + extOrJpg(fp);
      fs.writeFileSync(path.join(dir, base), buf);
      manifest.push({ index: idx, file: base, hotel: im.hotel || hotel || null, folder: im.folder || null, name: path.basename(fp), nasPath: fp });
      idx++;
    } catch {
      /* 개별 실패는 건너뜀 */
    }
  }

  const manifestObj = {
    label: dirName,
    theme,
    body,
    hotels: hotels || (hotel ? [hotel] : [...new Set(manifest.map((m) => m.hotel).filter(Boolean))]),
    imageDir: resolved ? resolved.imageDir : null,
    exportedAt: new Date().toISOString(),
    count: manifest.length,
    images: manifest,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifestObj, null, 2));
  fs.writeFileSync(
    path.join(dir, 'content.txt'),
    `주제: ${theme || '(미지정)'}\n호텔: ${manifestObj.hotels.join(', ') || '(미지정)'}\n\n본문:\n${body || '(미지정)'}\n`
  );

  return { dir, count: manifest.length, label: dirName, resolved };
}

module.exports = { exportCandidates, safeName };
