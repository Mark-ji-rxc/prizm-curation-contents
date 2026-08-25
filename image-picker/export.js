#!/usr/bin/env node
'use strict';
/**
 * CLI: 호텔의 후보 썸네일을 exports/<호텔>/ 로 내려받는다.
 * 여기(Claude Code)가 그 폴더의 이미지를 직접 보고 콘텐츠에 어울리는 사진을 추천하기 위함.
 *
 * ⛔ NAS 읽기 전용(Thumb만). 저장은 로컬 exports/ 에만.
 *
 * 사용법:
 *   node export.js --hotel "비스타 워커힐 서울"
 *   node export.js --hotel "웨스틴 조선 서울" --theme "조식이 포함된 객실" --n 30
 *   node export.js --hotel "그랜드 워커힐" --root "/volume1/사진DB/워커힐"   # 폴더 직접 지정
 *   node export.js --hotel "롯데호텔 서울" --candidates                      # 후보 폴더만 조회(내려받지 않음)
 */

const fs = require('fs');
const path = require('path');
const { Synology } = require('./synology');
const { exportCandidates } = require('./exporter');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--candidates') { a.candidates = true; continue; }
    if (k.startsWith('--')) { a[k.slice(2)] = argv[i + 1]; i++; }
  }
  return a;
}

function loadCfg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'nas.config.json'), 'utf8'));
  } catch {
    console.error('❌ nas.config.json 이 없습니다. nas.config.example.json 을 복사해 계정을 넣으세요.');
    process.exit(1);
  }
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.hotel) {
    console.error('사용법: node export.js --hotel "호텔명" [--theme "주제"] [--n 30] [--root "/폴더"] [--candidates]');
    process.exit(1);
  }
  const syno = new Synology(loadCfg());

  // 후보 폴더만 보기
  if (args.candidates) {
    const cands = await syno.collectRootCandidates(args.hotel);
    console.log(`\n'${args.hotel}' 후보 폴더(상위 12):`);
    cands.slice(0, 12).forEach((c, i) =>
      console.log(`  ${String(i + 1).padStart(2)}. [${c.score.toFixed(2)}] ${c.name}   →  ${c.path}`)
    );
    console.log('\n원하는 폴더로 다시: node export.js --hotel "..." --root "<위 경로>"\n');
    return;
  }

  const outRoot = path.join(__dirname, 'exports');
  fs.mkdirSync(outRoot, { recursive: true });

  console.log(`\n📥 '${args.hotel}' 폴더 해석 중…`);
  const res = await exportCandidates({
    syno,
    hotel: args.hotel,
    root: args.root || null,
    theme: args.theme || '',
    body: args.body || '',
    size: args.size || 'large',
    limit: args.n ? parseInt(args.n, 10) : 40,
    outRoot,
  });

  const r = res.resolved;
  if (r) {
    console.log(`  경로: ${(r.steps || []).map((s) => s.name).join('  ›  ')}`);
    if (!r.confident) console.log(`  ⚠ 매칭 신뢰도 낮음(${r.score}). 틀렸으면 --candidates 로 확인 후 --root 지정.`);
    if (r.usedFallback) console.log('  ⚠ 폴더명이 규칙과 달라 이미지 최다 폴더로 추정했습니다.');
  }
  console.log(`\n✅ ${res.count}장 저장: ${res.dir}`);
  console.log(`   → Claude Code에서: "${res.dir} 사진들 중 '${args.theme || '이 콘텐츠'}'에 어울리는 거 추천해줘"\n`);
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
