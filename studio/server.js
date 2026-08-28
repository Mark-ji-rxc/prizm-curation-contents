#!/usr/bin/env node
'use strict';
/**
 * PRIZM 콘텐츠 스튜디오 — 통합 로컬 웹 서버 (무의존성, Node 18+)
 * -----------------------------------------------------------------------------
 * 크롤링 → 콘텐츠 생성 → 이미지 찾기 → 미리보기 를 한 흐름으로.
 *
 *  ⛔ NAS는 읽기 전용. (image-picker 원칙 그대로 — 조회/썸네일/다운로드만)
 *  🤝 콘텐츠 생성/이미지 추천은 이 Claude Code 세션과 jobs/ 파일로 연동(API키 불필요).
 *
 *  실행:  node server.js   →  http://localhost:8790
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const crawl = require('./crawl');
const jobs = require('./jobs');
const { Synology, isImage } = require('../image-picker/synology');
const { exportCandidates } = require('../image-picker/exporter');
const overseas = require('./overseas');

const DIR = __dirname;
const PUBLIC = path.join(DIR, 'public');
const THUMB_CACHE = path.join(DIR, '.thumbcache');
const EXPORTS = path.join(DIR, 'exports');
const UPLOADS = path.join(DIR, 'uploads');
const STATE_FILE = path.join(DIR, 'state.json');
const SAVED_FILE = path.join(DIR, 'saved-contents.json');
const IP_DIR = path.join(DIR, '..', 'image-picker');
const PORT = process.env.PORT || 8790;

// ── NAS 설정(이미지-피커와 공유) ─────────────────────────────────────────────
function loadJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
const nasCfg = loadJson(path.join(IP_DIR, 'nas.config.json'));
const syno = nasCfg ? new Synology(nasCfg) : null;
if (!fs.existsSync(THUMB_CACHE)) fs.mkdirSync(THUMB_CACHE, { recursive: true });

// 예기치 못한 에러로 서버가 통째로 죽지 않도록(죽으면 이후 모든 요청이 "Failed to fetch") 가드.
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && (e.stack || e.message || e)));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && (e.message || e)));

// ── 공유 설정(studio.config.json) + 모범 콘텐츠 git 공유·큐레이션 ──────────────
// studio.config.json 예: { "referenceRepoDir": "/…/prizm-curation-editor", "user": "me@x.com", "autoPull": true }
const STUDIO_CFG = loadJson(path.join(DIR, 'studio.config.json')) || {};
const REF_DIR = (STUDIO_CFG.referenceRepoDir && (() => { try { return fs.existsSync(STUDIO_CFG.referenceRepoDir); } catch { return false; } })()) ? STUDIO_CFG.referenceRepoDir : DIR;
const REF_SHARED = REF_DIR !== DIR; // 공유 git 저장소 사용 여부
const { execFile, execFileSync } = require('child_process');
function git(args) { return new Promise((res) => execFile('git', args, { cwd: REF_DIR, timeout: 30000 }, (e, so, se) => res({ ok: !e, out: String(so || ''), err: String(se || (e && e.message) || '') }))); }
async function gitPull() { if (!REF_SHARED) return false; const r = await git(['pull', '--ff-only']); if (!r.ok) console.error('[git pull]', r.err); return r.ok; }
async function gitCommitPush(msg) {
  if (!REF_SHARED) return;
  await git(['add', '-A']);
  const c = await git(['commit', '-m', msg]); if (!c.ok && !/nothing to commit/.test(c.out + c.err)) console.error('[git commit]', c.err);
  const p = await git(['push']); if (!p.ok) console.error('[git push]', p.err);
}
// 현재 사용자 식별 + 담당자(큐레이터) 판별
function currentUser() {
  if (STUDIO_CFG.user) return String(STUDIO_CFG.user);
  try { const em = execFileSync('git', ['config', 'user.email'], { cwd: REF_DIR }).toString().trim(); if (em) return em; } catch {}
  try { return require('os').userInfo().username; } catch { return 'unknown'; }
}
function loadCurators() {
  const repo = loadJson(path.join(REF_DIR, 'curators.json'));
  if (repo && Array.isArray(repo.curators)) return repo.curators.map(String);
  if (Array.isArray(STUDIO_CFG.curators)) return STUDIO_CFG.curators.map(String);
  return [];
}
function curationEnabled() { return REF_SHARED && loadCurators().length > 0; } // 공유+담당자목록 있을 때만 제한
function isCurator() { return !curationEnabled() || loadCurators().includes(currentUser()); }

// ── 저장한 콘텐츠(즐겨찾기 — 나중에 재사용) ───────────────────────────────────
// 유실 방지: 저장할 때마다 타임스탬프 백업(.backups) + 최근 30개 보관. 본 파일이 없어지면 최신 백업에서 자동 복구.
const BACKUP_DIR = path.join(DIR, '.backups');
function loadSaved() {
  const cur = loadJson(SAVED_FILE);
  if (Array.isArray(cur)) return cur; // 정상(빈 배열 포함)
  try {
    const baks = fs.readdirSync(BACKUP_DIR).filter((f) => /^saved-.*\.json$/.test(f)).sort();
    if (baks.length) {
      const restored = loadJson(path.join(BACKUP_DIR, baks[baks.length - 1]));
      if (Array.isArray(restored)) { fs.writeFileSync(SAVED_FILE, JSON.stringify(restored, null, 2)); console.log(`[saved] 파일 유실 → 백업에서 복구: ${baks[baks.length - 1]} (${restored.length}개)`); return restored; }
    }
  } catch {}
  return [];
}
function saveSaved(arr) {
  fs.writeFileSync(SAVED_FILE, JSON.stringify(arr, null, 2));
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(BACKUP_DIR, `saved-${stamp}.json`), JSON.stringify(arr, null, 2));
    const baks = fs.readdirSync(BACKUP_DIR).filter((f) => /^saved-.*\.json$/.test(f)).sort();
    while (baks.length > 30) { try { fs.unlinkSync(path.join(BACKUP_DIR, baks.shift())); } catch {} }
  } catch (e) { console.error('[saved backup]', e.message); }
  return arr;
}
const contentKey = (it) => crypto.createHash('sha1').update((it.title || '') + '|' + (it.body || '')).digest('hex').slice(0, 12);

// ── 모범(참고) 콘텐츠 — 실제 에디터가 쓴 우수 콘텐츠를 few-shot 예시로 학습 ──────
const REFERENCE_FILE = path.join(REF_DIR, 'reference-content.json');
const REFERENCE_MD = path.join(REF_DIR, '모범콘텐츠_학습.md');
function loadReferences() { return loadJson(REFERENCE_FILE) || []; }
// 모범 콘텐츠를 사람이 읽고 이어서 쓸 수 있는 마크다운으로도 저장·갱신(지속 학습 자산).
function writeReferenceMarkdown() {
  const refs = loadReferences();
  const out = ['# 모범 콘텐츠 학습 (에디터 우수 콘텐츠 모음)', '',
    '> 콘텐츠 생성 시 이 예시들의 톤·구성·구체성·완성도를 참고(few-shot 학습)합니다. 좋은 콘텐츠가 쌓일수록 이후 생성 품질이 올라갑니다.',
    `> 최종 갱신: ${new Date().toLocaleString('ko-KR')} · 총 ${refs.length}편`, ''];
  refs.forEach((r, i) => {
    out.push(`## ${i + 1}. ${r.title || '(제목 없음)'}${r.form ? ` — ${r.form}` : ''}`);
    if (r.note) out.push(`> 메모: ${r.note}`);
    out.push('', r.body || '', '');
  });
  try { fs.writeFileSync(REFERENCE_MD, out.join('\n')); } catch (e) { console.error('[ref-md]', e.message); }
}
function saveReferences(a) { fs.writeFileSync(REFERENCE_FILE, JSON.stringify(a, null, 2)); writeReferenceMarkdown(); return a; }

// ── 저장 콘텐츠 학습 분석(insights) — 저장된 콘텐츠 특징을 분석해 생성에 반영 ──────
const SAVED_INSIGHTS_FILE = path.join(DIR, 'saved-insights.json');
const SAVED_LEARN_MD = path.join(DIR, '저장콘텐츠_학습분석.md');
function loadSavedInsights() { return loadJson(SAVED_INSIGHTS_FILE); }
function buildInsightsMd(ins) {
  const L = (a) => (a && a.length ? a.map((x) => `- ${x}`).join('\n') : '- (없음)');
  return ['# 저장 콘텐츠 학습 분석', '',
    `> 사용자가 "저장(좋아요)"한 콘텐츠 ${ins.count || 0}편을 분석해 도출한 학습 자산입니다. 콘텐츠 생성 시 이 원칙이 자동 반영됩니다.`,
    `> 최종 갱신: ${new Date(ins.updatedAt || Date.now()).toLocaleString('ko-KR')}`, '',
    '## 요약', ins.summary || '(없음)', '',
    '## 적용 원칙(생성에 주입)', L(ins.principles), '',
    '## 제목 패턴', L(ins.titlePatterns), '',
    '## 톤·보이스', ins.toneNotes || '(없음)', '',
    '## 피할 것', L(ins.avoid), ''].join('\n');
}
// 저장 콘텐츠 학습 분석 job 만들기 → Claude가 특징을 뽑아 output에 채움
function buildAnalyzeJob({ model }) {
  const saved = loadSaved();
  const compact = saved.map((s) => ({ title: s.title || '', body: s.body || '', form: s.form || '', persona: s.persona || '', hotels: (s.hotels || []).slice(0, 6) }));
  const instructions = [
    '이 파일은 "저장된(즐겨찾기한) 콘텐츠 학습 분석" 요청입니다. savedContents 를 분석해 이 파일을 덮어써 저장하세요.',
    '목표: 사용자가 좋다고 저장한 콘텐츠들의 공통 특징을 뽑아, 앞으로 "양질의 콘텐츠"를 생성할 때 바로 적용할 학습 자산을 만든다.',
    '1) savedContents(제목·본문·형·화자·매칭호텔)를 전부 읽고 공통 패턴을 분석한다: 톤/보이스, 자주 쓰는 후킹·도입 방식, 제목 구조·길이, 본문 전개·길이, 선호 주제/소재/타깃, 자주 쓰는 본문 형, 구체성의 수준, 구매 동기 유발 방식.',
    '2) 분석 결과로 "생성 지침에 그대로 주입할 원칙"을 8~15개 도출한다. 추상적 미사여구가 아니라, 다음 생성에 즉시 적용 가능한 구체적 규칙으로 쓴다(예: "제목은 숫자로 시작하는 편이 반응이 좋다", "본문 첫 문장은 장면 묘사로 연다" 등 실제 패턴 기반).',
    '3) 사람이 읽을 수 있는 마크다운 리포트(markdown)도 함께 작성한다.',
    '완료되면 status 를 "done" 으로 바꾸고 아래 output 형식으로 저장.',
    'output 형식: { "summary": "핵심 요약 2~3문장", "principles": ["원칙1", "원칙2", ...], "titlePatterns": ["자주 보이는 제목 패턴..."], "toneNotes": "톤·보이스 특징 서술", "avoid": ["피해야 할 것..."], "markdown": "# 저장 콘텐츠 학습 분석\\n..." }',
  ].join('\n');
  return jobs.createJob('analyze', { input: { model: model === 'sonnet' ? 'sonnet' : 'opus' }, count: saved.length, savedContents: compact, instructions, output: null });
}
// 분석 완료 시 insights JSON + 마크다운으로 수확(저장 콘텐츠 자체는 절대 건드리지 않음)
function harvestAnalyzeJob(job) {
  try {
    const o = job.output || {};
    const ins = { summary: o.summary || '', principles: o.principles || [], titlePatterns: o.titlePatterns || [], toneNotes: o.toneNotes || '', avoid: o.avoid || [], count: job.count || 0, updatedAt: new Date().toISOString() };
    fs.writeFileSync(SAVED_INSIGHTS_FILE, JSON.stringify(ins, null, 2));
    fs.writeFileSync(SAVED_LEARN_MD, (o.markdown && o.markdown.trim()) ? o.markdown : buildInsightsMd(ins));
    const jp = jobs.jobPath(job.id); const j = JSON.parse(fs.readFileSync(jp, 'utf8')); j.harvested = true; fs.writeFileSync(jp, JSON.stringify(j, null, 2));
  } catch (e) { console.error('[analyze-harvest]', e.message); }
}

// ── 예약 생성(스케줄) — 지정 시간에 자동 생성 → 저장된 콘텐츠로 수확 ───────────
const SCHEDULES_FILE = path.join(DIR, 'schedules.json');
function loadSchedules() { return loadJson(SCHEDULES_FILE) || []; }
function saveSchedules(a) { fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(a, null, 2)); return a; }
function minuteKey(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function isDue(sch, now) {
  const p = (n) => String(n).padStart(2, '0');
  if (sch.time !== `${p(now.getHours())}:${p(now.getMinutes())}`) return false;
  if (sch.cronType === 'daily') return true;
  if (sch.cronType === 'weekly') return now.getDay() === Number(sch.dayOfWeek);
  if (sch.cronType === 'once') return sch.date === `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  return false;
}
// 예약 파라미터로 콘텐츠 job 생성(+scheduled 표시) 후 Claude 자동 실행
function createScheduledJob(sch) {
  const job = buildContentJob({ ...(sch.params || {}), mode: 'generate' });
  try { const jp = jobs.jobPath(job.id); const o = JSON.parse(fs.readFileSync(jp, 'utf8')); o.scheduled = true; o.scheduleName = sch.name; o.harvested = false; fs.writeFileSync(jp, JSON.stringify(o, null, 2)); } catch {}
  dispatchToClaude(job.id, 'content');
  return job;
}
// 완료된 예약 job의 결과를 "저장된 콘텐츠"로 옮김(사용자가 나중에 확인)
function harvestScheduledJobs() {
  const done = jobs.listJobs('content').filter((j) => j.scheduled && j.status === 'done' && !j.harvested && j.output && j.output.items && j.output.items.length);
  if (!done.length) return;
  let saved = loadSaved();
  for (const j of done) {
    for (const it of j.output.items) {
      const id = contentKey(it);
      saved = saved.filter((x) => x.id !== id);
      saved.unshift({ ...it, id, savedAt: new Date().toISOString(), fromSchedule: j.scheduleName || true });
    }
    try { const jp = jobs.jobPath(j.id); const o = JSON.parse(fs.readFileSync(jp, 'utf8')); o.harvested = true; fs.writeFileSync(jp, JSON.stringify(o, null, 2)); } catch {}
  }
  saveSaved(saved);
  console.log(`[schedule] 예약 결과 ${done.length}건을 저장된 콘텐츠로 수확`);
}
function runScheduler() {
  try {
    const now = new Date(); const key = minuteKey(now);
    const schedules = loadSchedules(); let changed = false;
    for (const sch of schedules) {
      if (!sch.enabled || sch.lastRun === key) continue;
      if (isDue(sch, now)) {
        try { const job = createScheduledJob(sch); sch.lastRun = key; sch.lastRunAt = now.toISOString(); if (sch.cronType === 'once') sch.enabled = false; changed = true; console.log(`[schedule] "${sch.name}" 실행 → job ${job.id}`); }
        catch (e) { console.error('[schedule] 실행 오류', sch.name, e.message); }
      }
    }
    if (changed) saveSchedules(schedules);
    harvestScheduledJobs();
  } catch (e) { console.error('[scheduler]', e.message); }
}
setInterval(runScheduler, 30000); // 30초마다 점검

// ── 상태(단계 간 이어붙임) ───────────────────────────────────────────────────
function loadState() {
  return loadJson(STATE_FILE) || { dataset: {}, selectedContent: null, confirmedImages: [], updatedAt: null };
}
function saveState(s) {
  s.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  return s;
}
let state = loadState();
let officePostsCache = { at: 0, posts: [] }; // 백오피스 게시글 목록 캐시(캘린더용)

// ── ⑥ 발행 큐(여러 콘텐츠를 발행 설정까지 준비해 대기, 그중 선택 등록) ──────────
const PUBLISH_QUEUE_FILE = path.join(DIR, 'publish-queue.json');
function loadPublishQueue() { const a = loadJson(PUBLISH_QUEUE_FILE); return Array.isArray(a) ? a : []; }
function savePublishQueue(a) { try { fs.writeFileSync(PUBLISH_QUEUE_FILE, JSON.stringify(a, null, 2)); } catch (e) { console.error('[pubqueue]', e.message); } return a; }
const pubId = () => 'pub-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
// 현재 단계 상태(선택 콘텐츠·상품·이미지·미리보기 형태)로 발행 초안 1건 구성
function buildPublishDraft() {
  const c = state.selectedContent;
  if (!c) return null;
  const products = (state.selectedProducts && state.selectedProducts.length) ? state.selectedProducts : (c.matched || []);
  const cat = c.category || (function () { // 콘텐츠 분류 → 발행 도메인 자동추천
    const idx = buildDomOvsIndex(); return categoryOf({ matched: products }, idx);
  })();
  const domain = cat === 'domestic' ? 'domestic' : cat === 'overseas' ? 'overseas' : 'common';
  const publisher = domain === 'domestic' ? '체크인' : domain === 'overseas' ? '인트립' : '';
  const exposure = state.exposureType === 'showroom' ? 'showroom' : 'goods';
  let items;
  if (exposure === 'showroom') {
    items = (state.selectedShowrooms || []).map((s) => ({
      kind: 'showroom', showroomName: s.name || '', hotel: s.kind === 'hotel' ? (s.name || '') : (s.hotel || ''),
      region: s.kind === 'region' ? (s.name || '') : (s.region || ''), description: '',
    }));
  } else {
    items = products.map((m) => ({
      kind: 'goods', productId: m.productId || '', productName: m.productName || m.name || '', hotel: m.hotel || '',
      showroomName: m.hotel || m.region || '', region: m.region || '', type: m.type || '', description: '',
    }));
  }
  // 전시 종료일 기본값: 선택 상품 중 "가장 늦게까지 파는" 판매종료일(상시판매 포함 시 무기한). 쇼룸 노출은 미적용(수정 가능).
  let dpEnd = '', dpUnlimited = false;
  if (exposure !== 'showroom') {
    const sidx = crawlSaleIndex();
    const rs = products.map((p) => sidx.get(String(p.productCode || '')) || sidx.get(String(p.productId || ''))).filter(Boolean);
    if (rs.length) {
      if (rs.some((r) => r.alwaysOn || !r.saleEnd)) dpUnlimited = true; // 상시판매가 하나라도 있으면 가장 늦게까지 판매 → 무기한
      else { const mx = rs.map((r) => r.saleEnd).filter(Boolean).sort().pop(); if (mx) dpEnd = mx + 'T23:59'; } // YYYY-MM-DD → datetime-local
    }
  }
  return {
    content: { title: c.title || '', body: c.body || '', persona: c.persona || '', form: c.form || '', matched: products, hotels: c.hotels || [], category: cat },
    domain, publisherShowroom: publisher, exposure,
    mediaMode: state.publishFormat || (state.confirmedImages && state.confirmedImages.length ? 'normal' : 'off'),
    images: state.confirmedImages || [], matches: state.matches || {},
    items, filterKeywords: [], displayOrder: null, displayVisible: true,
    displayPeriod: { start: '', end: dpEnd, unlimited: dpUnlimited }, status: 'draft',
  };
}
// 크롤 데이터 인덱스(상품코드/ID → 상품). 판매종료일·상시판매 조회용.
function crawlSaleIndex() {
  const m = new Map();
  for (const s of ['domestic', 'overseas']) { try { for (const r of crawl.normalizedItems(s)) { if (r.productCode) m.set(String(r.productCode), r); if (r.productId) m.set(String(r.productId), r); } } catch {} }
  return m;
}
// custom description 자동생성 job (상품/쇼룸별 14자 이하 요약)
function buildPublishDescJob(items) {
  const compact = (items || []).map((it, i) => ({ i, name: it.productName || it.showroomName || '', hotel: it.hotel || '', region: it.region || '', type: it.type || '', kind: it.kind }));
  const instructions = [
    '이 요청은 "발행 아이템별 짧은 설명(description) 자동생성"입니다. items 각각에 14자 이하의 매력적인 한 줄 설명을 만들어 이 파일을 덮어써 저장하세요.',
    '규칙: 공백 포함 14자 이하(엄수). 그 상품/쇼룸의 핵심 매력을 압축(예: "오션뷰 스위트", "미쉐린 3스타 미식", "가성비 시티 호캉스"). 과장·상투구 금지, 구체적 특징 위주. hotel/region/type/name을 근거로.',
    '완료 시 status "done", output 형식: { "descriptions": [ { "i": 0, "description": "오션뷰 스위트" }, ... ] } — items 개수만큼.',
  ].join('\n');
  return jobs.createJob('pubdesc', { input: { model: 'opus' }, items: compact, instructions, output: null });
}
// 발행 항목의 이미지를 로컬로 스테이징(NAS/업로드 → publish-staging/<id>/) — 재사용 함수
async function stageImagesFor(it) {
  const imgs = (it.images || []).filter((im) => im && (im.nasPath || im.path));
  const dir = path.join(DIR, 'publish-staging', it.id);
  fs.mkdirSync(dir, { recursive: true });
  try { for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)); } catch {}
  if (!imgs.length) return { dir, count: 0, files: [] };
  const { safeName } = require('../image-picker/exporter');
  const files = [];
  for (let i = 0; i < imgs.length; i++) {
    const src = imgs[i].nasPath || imgs[i].path || '';
    let ext = (path.extname(src) || '.jpg').toLowerCase(); if (!/\.(jpg|jpeg|png|webp|gif|mp4)$/i.test(ext)) ext = '.jpg';
    const local = path.join(dir, String(i + 1).padStart(2, '0') + '_' + safeName((imgs[i].name || path.basename(src) || 'img').replace(/\.[^.]+$/, '')).slice(0, 40) + ext);
    try {
      let buf;
      if (src.startsWith('upload:')) { const up = path.join(UPLOADS, src.slice('upload:'.length)); if (up.startsWith(UPLOADS) && fs.existsSync(up)) buf = fs.readFileSync(up); }
      else if (syno) { const r = await syno.download(src); buf = Buffer.from(await r.arrayBuffer()); }
      if (buf && buf.length) { fs.writeFileSync(local, buf); files.push({ nasPath: src, name: imgs[i].name || path.basename(src), localPath: local }); }
    } catch (e) { console.error('[stage-images]', src, e.message); }
  }
  return { dir, count: files.length, files };
}
// 발행 실행(헤드리스 Playwright) — 백그라운드로 스테이징+등록, 상태 갱신
function runPublishJob(id) {
  (async () => {
    const setStatus = (patch) => { const a = loadPublishQueue(); const x = a.find((y) => y.id === id); if (x) { Object.assign(x, patch); savePublishQueue(a); } return x; };
    try {
      const it = loadPublishQueue().find((y) => y.id === id);
      if (!it) return;
      const staged = await stageImagesFor(it);
      let publishItem; try { ({ publishItem } = require('./publisher')); } catch (e) { setStatus({ status: 'failed', error: 'Playwright 미설치: npm i playwright && npx playwright install chromium' }); return; }
      // custom(상품↔이미지 1:1): productId → 로컬 이미지 경로. matches(key=productCode|productId|productName)→nasPath→staged.localPath
      let customImages = null;
      if (it.mediaMode === 'custom') {
        customImages = {};
        const local = {}; for (const f of (staged.files || [])) local[f.nasPath] = f.localPath;
        const matched = (it.content && it.content.matched) || [];
        for (const g of (it.items || [])) {
          if (g.kind === 'showroom' || !g.productId) continue;
          const m = matched.find((x) => String(x.productId) === String(g.productId)) || {};
          const key = String(m.productCode || m.productId || g.productId || m.productName || g.productName || '');
          const nas = (it.matches || {})[key];
          if (nas && local[nas]) customImages[String(g.productId)] = local[nas];
        }
      }
      const r = await publishItem(it, staged.files, customImages);
      if (r.ok) setStatus({ status: 'published', publishedAt: new Date().toISOString(), error: '' });
      else setStatus({ status: 'failed', error: r.error || '실패' });
      console.log('[publish]', id, r.ok ? '성공' : ('실패: ' + r.error));
    } catch (e) { setStatus({ status: 'failed', error: e.message }); console.error('[publish]', id, e.message); }
  })();
}

// ── Claude 자동 호출(헤드리스) ────────────────────────────────────────────────
// [생성] 시 프로그램이 `claude -p` 를 별도 프로세스로 띄워 pending job을 직접 처리한다.
// 사람이 문구를 붙여넣을 필요 없음. 구독으로 동작(API 추가 결제 없음). AUTO_CLAUDE=0 이면 수동 모드.
const AUTO_CLAUDE = process.env.AUTO_CLAUDE !== '0';
// 더블클릭 실행(최소 PATH)에서도 claude를 찾도록 실행 경로 자동 탐지
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const home = process.env.HOME || '';
  const cands = [`${home}/.local/bin/claude`, '/usr/local/bin/claude', '/opt/homebrew/bin/claude', `${home}/.claude/local/claude`];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return 'claude'; // PATH에 있으면 사용
}
const CLAUDE_BIN = resolveClaudeBin();
function dispatchToClaude(jobId, kind) {
  if (!AUTO_CLAUDE) return false;
  const job = jobs.readJob(jobId);
  const model = (job && job.input && job.input.model) || 'opus';
  const web = !!(job && job.input && job.input.webSearch);
  const prompt =
    `이 저장소의 job 파일 \`jobs/${jobId}.json\` 을 Read로 열고, 그 안의 "instructions" 지침을 그대로 따라 처리한 뒤, ` +
    `해당 파일의 status 를 "done" 으로 바꾸고 output 을 채워 같은 경로에 저장해줘. 그 파일 하나만 수정하고 끝내.`;
  const args = ['-p', prompt, '--model', model, '--permission-mode', 'acceptEdits', '--output-format', 'json'];
  if (web) args.push('--allowedTools', 'WebSearch', 'WebFetch'); // 인터넷 검색 허용(브리프/보강 생성)
  try {
    const child = spawn(CLAUDE_BIN, args, { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => console.error(`[auto-claude] ${kind} ${jobId} spawn 실패:`, e.message));
    child.on('close', (code) => {
      console.log(`[auto-claude] ${kind} ${jobId} 종료(code ${code}, model ${model})`);
      // 토큰/비용 사용량 파싱 → job에 기록(“토큰 쓰는지” 확인·표시용)
      try {
        const j = JSON.parse(out);
        const u = j.usage || {};
        const usage = { model, inputTokens: u.input_tokens || 0, cacheReadTokens: u.cache_read_input_tokens || 0, cacheCreateTokens: u.cache_creation_input_tokens || 0, outputTokens: u.output_tokens || 0, costUsd: j.total_cost_usd || 0, durationMs: j.duration_ms || 0 };
        const jp = jobs.jobPath(jobId); const o = JSON.parse(fs.readFileSync(jp, 'utf8')); o.usage = usage; fs.writeFileSync(jp, JSON.stringify(o, null, 2));
        console.log(`[auto-claude] ${jobId} 사용량: 입력 ${usage.inputTokens}+캐시 ${usage.cacheReadTokens}/${usage.cacheCreateTokens}, 출력 ${usage.outputTokens}, $${usage.costUsd.toFixed(4)}`);
      } catch {}
      if (code !== 0) console.error('[auto-claude tail]', String(out + err).slice(-800));
    });
    return true;
  } catch (e) {
    console.error('[auto-claude] 실행 불가:', e.message);
    return false;
  }
}

// ── 콘텐츠 제작 규칙 요약(가이드 발췌 — job에 첨부해 Claude가 그대로 따르게) ────
const CONTENT_RULES = {
  구조: '제목 + 본문',
  제목: '공백 포함 8~16자. 짧고 임팩트, 큐레이션 성격이 드러나되 노골적이지 않게.',
  본문: '공백 포함 100~300자. 무엇이 좋은지 + 왜 이렇게 묶었는지를 고객 상황에서 와닿게.',
  톤: '친근한 반말 표현 + 존댓말 마무리를 섞은 하우스 보이스. 어미·문장 시작·길이 변주(기계적 반복 금지).',
  본문형: ['①후기·고백형', '②장면·몰입형', '③반전·통념깨기형', '④팁·정보형', '⑤단정·선언형', '⑥조건·타깃지목형', '⑦질문·대화형', '⑧비교·대조형', '⑨숫자·근거형', '⑩큐레이터편지형'],
  상품매칭: '각 콘텐츠는 주제 조건에 맞는 판매중 상품 "전체"를 매칭한다(대표 1~2개만 X). 호텔명 — 상품명 형식. 판매예정/매진 표기.',
  주의: '실제 상품이 존재하는 주제만. 여행지 소개는 사실확인 후 출처 표기.',
};
const THEME_PRESETS = {
  domestic: ['서울 시티 호캉스', '조식 2인 무료', '4인 가족 한 객실(추가요금 0)', '부모님 1박(같은 층)', '평일 한정 PKG', '24h 스테이', '통영·여수 남해안', '1박 100만원 사치', '재투숙률 높은 호텔', '굿즈 컬렉션', '다이닝 인클루시브', '오션뷰', '반려견 동반', '키즈 프렌들리'],
  overseas: ['부모님 첫 해외 효도', '3대 가족여행(6~8인)', '일본 소도시 미식', '미쉐린 미식', '풀가이드 동행', '에어텔의 정석', '연차 없이 2박3일', '황금연휴 사전예약 알림', '프라이빗 트랜스퍼', '5성급 동남아 휴양', '노 옵션·노 팁·노 쇼핑', '국적기로 떠나는 여행', '렌터카 자유여행'],
};

// ── HTTP 유틸 ────────────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function sendErr(res, code, message) { sendJson(res, code, { error: message }); }
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC)) return sendErr(res, 403, 'forbidden');
  fs.readFile(filePath, (err, buf) => {
    if (err) return sendErr(res, 404, 'not found');
    // 로컬 개발툴: 화면(html/js/css) 변경이 새로고침에 바로 반영되도록 캐시 금지(예전 CSS가 캐시돼 버튼 정렬 등이 안 바뀌던 문제 방지).
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}
function requireSyno(res) {
  if (!syno) { sendErr(res, 503, 'NAS 미설정: image-picker/nas.config.json 을 작성한 뒤 재시작하세요.'); return false; }
  return true;
}
function thumbCachePath(filePath, size, mtime) {
  const h = crypto.createHash('sha1').update(`${filePath}|${size}|${mtime || ''}`).digest('hex');
  return path.join(THUMB_CACHE, `${h}.img`);
}
// 스트림 에러가 프로세스를 죽이지 않도록 error 핸들러 부착 후 파이프.
function safePipe(res, filePath) {
  const s = fs.createReadStream(filePath);
  s.on('error', (e) => { console.error('[stream error]', filePath, e && e.message); try { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); } catch {} try { res.end(); } catch {} });
  return s.pipe(res);
}
const UP_CT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
// 'upload:<id>' 로컬 업로드 파일 서빙(썸네일/원본 공통). NAS 아님.
function serveUpload(res, uploadPath, asDownload) {
  const id = path.basename(uploadPath.slice('upload:'.length));
  const file = path.join(UPLOADS, id);
  if (!file.startsWith(UPLOADS) || !fs.existsSync(file)) return sendErr(res, 404, '업로드 파일 없음');
  const headers = { 'content-type': UP_CT[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'max-age=86400' };
  if (asDownload) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(id)}`;
  res.writeHead(200, headers);
  return safePipe(res, file);
}

// ── 크롤 실행 레지스트리(진행 로그 폴링) ──────────────────────────────────────
const runs = new Map(); // runId -> { log:[], running, error, result }
function startCrawl(scope) {
  const runId = crypto.randomBytes(4).toString('hex');
  const rec = { log: [], running: true, error: null, result: {} };
  runs.set(runId, rec);
  const onLog = (line) => { rec.log.push(line); if (rec.log.length > 2000) rec.log.shift(); };
  const sources = scope === 'both' ? ['domestic', 'overseas'] : [scope];
  (async () => {
    try {
      for (const s of sources) {
        const info = await crawl.runCrawl(s, onLog);
        rec.result[s] = info;
        state.dataset[s] = info ? { jsonFile: info.jsonFile, csvFile: info.csvFile, count: info.count, updatedAt: info.updatedAt } : null;
        saveState(state);
      }
      onLog('모든 상품 불러오기 완료 ✓');
    } catch (e) {
      rec.error = e.message; onLog('오류: ' + e.message);
    } finally {
      rec.running = false;
    }
  })();
  return runId;
}

// 판매 조건 필터: all(노출 전체·상태무관) | selling(판매중만) | always(상시판매만) | until(특정일까지) | upcoming(판매예정만)
function applyCondition(items, condition, untilDate) {
  const selling = items.filter((r) => r.status === '판매중');
  switch (condition) {
    case 'all': return items.slice(); // 크롤링한 모든 상품(판매중·판매예정·매진 포함)
    case 'upcoming': return items.filter((r) => r.status === '판매예정');
    case 'always': return selling.filter((r) => r.alwaysOn);
    case 'until': return selling.filter((r) => r.alwaysOn || (r.saleEnd && untilDate && r.saleEnd >= untilDate));
    default: return selling; // 'selling' = 판매중만
  }
}
const CONDITION_LABEL = { all: '노출 상품 전체(판매중·판매예정·매진 포함)', selling: '판매중', always: '상시판매', until: '특정일까지 판매', upcoming: '판매예정' };

// 우선순위: productCodes(직접 선택) > productTypes(타입 조건, 양쪽 데이터셋) > 조건+지역(단일 scope)
function pickProducts({ scope, region, condition, until, productCodes, productTypes }) {
  if (Array.isArray(productCodes) && productCodes.length) {
    const set = new Set(productCodes.map(String));
    const all = [...crawl.normalizedItems('domestic'), ...crawl.normalizedItems('overseas')];
    return all.filter((r) => set.has(String(r.productCode)) || (r.productId && set.has(String(r.productId))));
  }
  if (Array.isArray(productTypes) && productTypes.length) {
    const set = new Set(productTypes);
    const all = [...applyCondition(crawl.normalizedItems('domestic'), condition || 'selling', until), ...applyCondition(crawl.normalizedItems('overseas'), condition || 'selling', until)];
    return all.filter((r) => set.has(r.productType));
  }
  let items = applyCondition(crawl.normalizedItems(scope), condition || 'selling', until);
  if (region) {
    if (scope === 'overseas') items = items.filter((r) => overseasRegion(r) === region);
    else items = items.filter((r) => r.region === region);
  }
  return items;
}
// 해외 상품은 국가/도시 필드가 없고 지역명(예: "푸꾸옥 자유 패키지")만 있어 이를 도시/지역으로 정규화한다.
// - 해외 패키지·현지 투어: "도시 카테고리" 구조 → 첫 어절(도시). ('일본 현지투어'처럼 데이터가 국가로 쓰는 경우도 그대로 존중)
// - 해외 호텔: 지역명이 호텔명이라 이름 속 도시 키워드를 추출(없으면 마지막 어절).
const HOTEL_CITY = ['하노이', '호치민', '다낭', '나트랑', '푸꾸옥', '방콕', '푸켓', '치앙마이', '세부', '보라카이', '마닐라', '도쿄', '오사카', '교토', '후쿠오카', '삿포로', '나고야', '오키나와', '싱가포르', '발리', '자카르타', '홍콩', '마카오', '타이베이', '가오슝', '코타키나발루', '쿠알라룸푸르', '괌', '사이판'];
// 국가 단위로 묶을 도시/지역 → 대표명. (요청: 일본 도시들은 "일본"으로 묶음. 베트남 등은 도시 단위 유지)
const REGION_GROUP = { 오사카: '일본', 기타규슈: '일본', 대마도: '일본', 이시가키: '일본', 후쿠오카: '일본', 삿포로: '일본', 도쿄: '일본', 교토: '일본', 나고야: '일본', 오키나와: '일본', 일본: '일본' };
function overseasRegion(r) {
  const reg = String(r.region || '').trim();
  if (!reg) return '';
  let name;
  if (r.type === '해외 호텔' || r.productType === '해외 호텔') {
    const city = HOTEL_CITY.find((c) => reg.includes(c));
    const parts = reg.split(/\s+/);
    name = city || parts[parts.length - 1] || reg;
  } else {
    name = reg.split(/\s+/)[0] || reg;
  }
  return REGION_GROUP[name] || name; // 일본 등 국가 그룹으로 통합
}
// 콘텐츠 생성 UI용: scope별 지역 목록(해외는 도시/지역으로 정규화). [{region,count}] ko 정렬.
function regionList(scope) {
  const m = new Map();
  for (const r of crawl.normalizedItems(scope)) {
    const name = scope === 'overseas' ? overseasRegion(r) : String(r.region || '').trim();
    if (!name) continue;
    m.set(name, (m.get(name) || 0) + 1);
  }
  return [...m.entries()].map(([region, count]) => ({ region, count })).sort((a, b) => a.region.localeCompare(b.region, 'ko'));
}
// 콘텐츠 생성 UI용: 존재하는 상품 타입 목록(프리미엄 호텔·리조트·라이프스타일·해외패키지·해외호텔·현지투어 등)
function productTypeList() {
  const map = new Map(); // type -> {count, domestic, overseas}
  for (const s of ['domestic', 'overseas']) for (const r of crawl.normalizedItems(s)) {
    if (!r.productType) continue;
    const e = map.get(r.productType) || { count: 0, domestic: 0, overseas: 0 };
    e.count++; e[s]++; map.set(r.productType, e);
  }
  // source: 국내/해외 구분(둘 다면 both) — UI에서 선택 구분에 맞춰 필터
  return [...map.entries()].map(([type, e]) => ({ type, count: e.count, source: e.domestic && e.overseas ? 'both' : e.domestic ? 'domestic' : 'overseas' })).sort((a, b) => b.count - a.count);
}
// 콘텐츠 생성 UI용: 현재 필터(구분+지역+판매조건+날짜)에 해당하는 타입별 상품 수. 0개 타입은 선택 불가/전체 0이면 생성 불가 판단용.
function typeCountsFor({ scope, region, condition, until }) {
  const items = pickProducts({ scope, region, condition, until }); // productCodes/Types 없음 → 구분+지역+판매조건 풀
  const counts = {};
  for (const r of items) { if (r.productType) counts[r.productType] = (counts[r.productType] || 0) + 1; }
  return { counts, total: items.length };
}
// 저장 콘텐츠를 국내 호텔 / 해외 여행상품으로 분류(매칭 상품코드·ID를 데이터셋과 대조)
function buildDomOvsIndex() {
  const dom = new Set(), ovs = new Set();
  try { for (const r of crawl.normalizedItems('domestic')) { if (r.productCode) dom.add(String(r.productCode)); if (r.productId) dom.add(String(r.productId)); } } catch {}
  try { for (const r of crawl.normalizedItems('overseas')) { if (r.productCode) ovs.add(String(r.productCode)); if (r.productId) ovs.add(String(r.productId)); } } catch {}
  return { dom, ovs };
}
function categoryOf(item, idx) {
  if (item.category === 'domestic' || item.category === 'overseas') return item.category; // 저장 시 기록돼 있으면 우선
  let d = 0, o = 0;
  for (const m of (item.matched || [])) {
    const c = String(m.productCode || ''), id = String(m.productId || '');
    if ((c && idx.dom.has(c)) || (id && idx.dom.has(id))) d++;
    else if ((c && idx.ovs.has(c)) || (id && idx.ovs.has(id))) o++;
  }
  if (d && d >= o) return 'domestic';
  if (o) return 'overseas';
  return 'unknown';
}
function categorizeSaved(items) { const idx = buildDomOvsIndex(); return items.map((it) => ({ ...it, category: categoryOf(it, idx) })); }
// 콘텐츠 매칭 상품을 실제 크롤 데이터와 대조해 "정확한 쇼룸명" 도출(국내=호텔명, 해외=지역명).
// 등록 시 쇼룸 검색 오류를 막기 위해 LLM 텍스트가 아닌 데이터셋의 정확 명칭을 사용.
function resolveShowrooms(matched) {
  const idxOf = (arr) => { const m = new Map(); arr.forEach((r) => { if (r.productCode) m.set(String(r.productCode), r); if (r.productId) m.set(String(r.productId), r); }); return m; };
  let di, oi; try { di = idxOf(crawl.normalizedItems('domestic')); } catch { di = new Map(); }
  try { oi = idxOf(crawl.normalizedItems('overseas')); } catch { oi = new Map(); }
  const out = new Map();
  (matched || []).forEach((mm) => {
    const code = String(mm.productCode || ''), id = String(mm.productId || '');
    let r = di.get(code) || di.get(id), src = 'domestic';
    if (!r) { r = oi.get(code) || oi.get(id); src = 'overseas'; }
    let name, kind, exact;
    if (r) { exact = true; if (src === 'overseas') { name = r.region || r.hotel || ''; kind = 'region'; } else { name = r.hotel || ''; kind = 'hotel'; } }
    else { exact = false; if (mm.hotel) { name = mm.hotel; kind = 'hotel'; } else { name = mm.region || ''; kind = 'region'; } } // 데이터에 없으면 매칭 텍스트로 폴백
    if (!name) return;
    if (!out.has(name)) out.set(name, { name, kind, code: (r && (r.productCode || r.productId)) || mm.productCode || mm.productId || '', hotel: (r && r.hotel) || mm.hotel || '', region: (r && r.region) || mm.region || '', products: [], exact });
    out.get(name).products.push((r && r.productId) || mm.productId || '');
  });
  return [...out.values()];
}

// 상품을 job에 넣을 때 토큰 절약을 위해 필요한 필드만 + 혜택 요약(속도 개선). 긴 원문(detail) 대신 압축.
function compactForJob(items) {
  return items.map((r) => ({
    productId: r.productId, productCode: r.productCode, hotel: r.hotel, region: r.region, type: r.type, productType: r.productType,
    name: r.name, price: r.price, discount: r.discount, nights: r.nights, status: r.status, url: r.url,
    flags: r.flags, benefits: (r.detail || '').replace(/\s+/g, ' ').trim().slice(0, 160),
  }));
}

// ── 콘텐츠 생성 job 만들기 ────────────────────────────────────────────────────
// mode: 'generate'(주제 자동 도출) | 'match'(내가 쓴 콘텐츠 매칭) | 'brief'(지시/브리프로 생성)
function buildContentJob({ topic, count, perTopic, forms, scope, region, form, persona, condition, until, productCodes, productTypes, mode, userTitle, userBody, model, brief, webSearch, bodyMin, bodyMax }) {
  const per = Math.max(1, Number(perTopic) || 1);
  const web = !!webSearch;
  // 본문 글자수 범위(조정 가능). 기본 100~300자. 값이 오면 20~2000자로 클램프하고 min<max 보장.
  let bMin = Math.round(Number(bodyMin)) || 100, bMax = Math.round(Number(bodyMax)) || 300;
  bMin = Math.min(Math.max(bMin, 20), 2000); bMax = Math.min(Math.max(bMax, 20), 2000);
  if (bMax < bMin) [bMin, bMax] = [bMax, bMin];
  const bodyRule = `공백 포함 ${bMin}~${bMax}자`;
  const bodyLenNote = bMax > 300 ? `※ 본문을 길게(${bMin}~${bMax}자) 쓸 때는 장면·디테일·근거를 더 풍부하게 전개하되, 군더더기·반복·상투구로 늘리지 말 것. 끝까지 밀도를 유지한다.` : '';
  const webLine = web ? '※ 인터넷 검색 사용: 여행지·명물·상품의 사실·수치·현지 이야기를 WebSearch로 확인해 콘텐츠에 구체적으로 반영한다. 부정확·추측 금지, 신뢰할 출처만. (검색은 꼭 필요한 것만 간결하게.)' : '';
  const webLineGen = web ? '※ 인터넷 검색 활용(2가지): (1) 주제 발굴 — 요즘 화제·시즌·트렌드(계절 이벤트, 제철 명물, 연휴, 뜨는 여행지·테마, 최신 이슈)를 WebSearch로 찾아 "유저 관심이 높을 새로운 주제"를 발굴한다. 단, 반드시 실제 products와 연결되는 주제만 채택(데이터에 상품이 없으면 버림). (2) 사실 확인 — 여행지·명물의 유래·수치·현지 이야기를 검색으로 확인해 정확히 반영(추측·부정확 금지). 검색은 필요한 만큼만.' : '';
  const formList = Array.isArray(forms) ? forms.filter(Boolean) : (form ? [form] : []);
  const cond = condition || 'selling';
  const items = pickProducts({ scope, region, condition: cond, until, productCodes, productTypes });
  const references = loadReferences().slice(0, 6); // 실제 에디터 우수 콘텐츠(있으면 few-shot으로)
  const refLine = references.length
    ? `★ referenceExamples: 실제 에디터가 쓴 우수 콘텐츠 ${references.length}편이다(제목/본문/형). 이 톤·구성·구체성·완성도를 "학습"해 같은 퀄리티로 써라. 문장·표현을 그대로 베끼지 말고 스타일·디테일 수준만 흡수한다.`
    : '';
  // 저장 콘텐츠 학습 분석에서 도출된 원칙(있으면 생성에 주입 — 사용자 선호 스타일 반영)
  const _ins = loadSavedInsights();
  const insLine = (_ins && Array.isArray(_ins.principles) && _ins.principles.length)
    ? `★ savedInsights: 사용자가 "저장(좋아요)"한 콘텐츠들을 분석해 도출한 선호 원칙이다. 이 원칙을 적극 반영해 사용자가 좋아할 스타일로 써라:\n- ${_ins.principles.join('\n- ')}`
    : '';
  const typeDesc = (productTypes && productTypes.length) ? ` · 타입: ${productTypes.join(', ')}만` : '';
  const scopeDesc = ((productCodes && productCodes.length) ? `직접 선택한 상품 ${items.length}개 한정` : (cond === 'until' ? `${until || ''}까지 판매(상시 포함)` : (CONDITION_LABEL[cond] || '판매중') + ' 상품')) + typeDesc;
  let instructions;
  if (mode === 'match') {
    instructions = [
      '이 요청은 "사용자가 직접 작성한 콘텐츠에 어울리는 상품·호텔·여행지 매칭"입니다. 아래 지침대로 처리해 이 파일을 덮어써 저장하세요.',
      `0) products 범위: ${scopeDesc}. 이 목록 안에서만 매칭한다.`,
      '1) input.userContent(제목/본문)를 분석해 주제·분위기·키워드(지역/혜택/타깃/가격대/계절 등)를 파악한다.',
      '2) 그 콘텐츠에 어울리는 products 를 matched 에 담는다. 콘텐츠와 실제로 연관되는 상품만(근거 없는 상품 금지). 각 상품은 productId(숫자)·productCode(영문)를 그대로 복사.',
      '3) hotels(매칭 호텔/여행지 중복 제거)도 채운다. form/persona 는 본문 톤에서 추정해 넣는다(모르면 빈 값).',
      '4) output.items 는 정확히 1개. title/body 는 input.userContent 를 그대로 사용.',
      '완료되면 status 를 "done" 으로 바꾸고 output 저장.',
      'output 형식: { "items": [ { "title": "(사용자 제목)", "body": "(사용자 본문)", "form": "", "persona": "", "hotels": [...], "matched": [ {"productId":"99500","productCode":"2gx2yiq8","hotel":"...","productName":"...","price":123000,"url":"https://...","status":"판매중"} ] } ] }',
    ].join('\n');
  } else if (mode === 'brief') {
    instructions = [
      '이 요청은 "브리프(지시)로 콘텐츠 생성"입니다. input.brief 의 방향·컨셉·스토리를 살려 콘텐츠를 만들어 이 파일을 덮어써 저장하세요.',
      `0) products 범위: ${scopeDesc}. 매칭은 이 목록 안에서.`,
      '1) input.brief 를 해석해 핵심 컨셉·후킹 포인트를 잡는다. 브리프에 담긴 스토리(현지 유래·명물·계절·식감 등)를 그대로 살린다.',
      webLine || '※ 사실·수치·현지 이야기는 정확히. 모르면 단정하지 말 것.',
      `2) input.count 개의 콘텐츠를 하우스 보이스(친근한 반말+존댓말 마무리)로 쓴다: 제목 8~16자(임팩트·호기심), 본문 ${bodyRule}(구체적·생생·구매 동기). 브리프의 결을 살려 "그곳에 가고/사고 싶게".`,
      bodyLenNote,
      '3) 각 콘텐츠에 titleAlternatives(제목 다른 후보 2~4개, 각 후보에 한 줄 근거)를 포함한다.',
      '4) 브리프·여행지에 맞는 products 를 matched 에(관련 상품만, productId·productCode 둘 다). hotels(중복 제거)도 채운다. input.persona 있으면 화자로, form 은 어울리는 형으로.',
      refLine,
      insLine,
      '5) 완료 시 status "done", output.items 는 정확히 input.count 개.',
      'output 형식: { "items": [ { "title": "...", "body": "...", "form": "②장면·몰입형", "persona": "", "titleAlternatives": [ {"title":"...","reason":"..."} ], "hotels": [...], "matched": [ {"productId":"99500","productCode":"2gx2yiq8","hotel":"...","productName":"...","price":123000,"url":"https://...","status":"판매중"} ] } ] }',
    ].filter(Boolean).join('\n');
  } else {
    instructions = [
      '이 파일은 프로그램이 만든 "콘텐츠 생성 요청"입니다. 아래 지침대로 콘텐츠를 만들어 이 파일을 덮어써 저장하세요.',
      `0) products 범위: ${scopeDesc}. 이 목록 안에서만 주제·매칭을 만든다. products[]에는 hotel/region/type/name/price/flags/benefits(혜택요약) 등이 있으니 이를 근거로 구체적으로 쓴다.`,
      '1) input.count = "주제 개수", input.perTopic = "주제별 콘텐츠 개수". 총 count×perTopic 개를 만든다.',
      '2) products 를 훑어 서로 다른 주제를 count개 도출(지역/숙소타입/뷰/다이닝/특전/타깃/가격대/계절/테마 등 축을 폭넓게 달리, 겹치지 않게). input.topic 있으면 참고, 없으면 데이터 기반. input.webSearch=true 면 인터넷 검색으로 요즘 화제·시즌·트렌드를 찾아 "새롭고 관심 높을 주제"를 적극 발굴한다(아래 ※ 참고). 실제 상품 없는 주제 금지.',
      '3) 각 주제마다 perTopic개 콘텐츠를 쓴다. 같은 주제의 콘텐츠들은 그 주제의 matched(조건 맞는 products 전체)를 공유한다.',
      '4) 본문 형(input.forms) 배정 규칙 — 10형: ①후기·고백형 ②장면·몰입형 ③반전·통념깨기형 ④팁·정보형 ⑤단정·선언형 ⑥조건·타깃지목형 ⑦질문·대화형 ⑧비교·대조형 ⑨숫자·근거형 ⑩큐레이터편지형.',
      '   - forms 비어 있으면: 형을 자유롭게 다양화.  - perTopic>forms.length: forms 각 1회+남는건 나머지 형에서 랜덤.  - forms.length>perTopic: forms 중 중복없이 perTopic개 랜덤.  - 같으면 각 1회.',
      '★★ 다양성·품질 (가장 중요 — 유저가 획일적이라고 느끼면 실패):',
      '  a) 제목은 같은 형이어도 구문·훅·각도를 매번 완전히 다르게. 특정 틀의 반복 절대 금지 — 예: "A vs B", "지역, 이렇게 고르자/뭘 봐야 하나", "N만원부터 지역+숙소", "지역 한옥, …". 생성한 제목 전체가 서로 다른 구조여야 한다(같은 형이 여러 개면 각기 다른 리듬으로).',
      '  b) 본문 형은 "톤 가이드"일 뿐 템플릿이 아니다. 형은 지키되 문장·전개는 자유롭게.',
      '  c) 숙소/여행지/상품의 "구체적 실체"에 근거해 쓴다: 그 호텔만의 특징(뷰·위치·객실·다이닝·시설·특전), 그 여행지의 매력(명물·풍경·계절·분위기), 상품의 실제 혜택(products[].flags/benefits/name). 일반론·상투구·모호한 미사여구 금지.',
      '  d) 읽는 사람이 "그 숙소·여행지를 둘러보고 싶다 / 사고 싶다"는 마음이 들도록 호기심과 구체성, 구매 동기(가성비·희소성·경험·타깃 적합성)를 자연스럽게 녹인다.',
      `5) 각 콘텐츠: 제목 8~16자, 본문 ${bodyRule}, 하우스 보이스, 기계적 반복 금지. item.form 에 실제 사용한 형을 적는다. input.persona 있으면 화자로 반영.`,
      bodyLenNote,
      '6) 각 콘텐츠에 matched(productId·productCode 둘 다)와 hotels(중복 제거) 채운다. 여행지/명물은 사실확인 후 필요시 web 검색.',
      '7) 완료 시 status "done", output.items 는 정확히 count×perTopic 개.',
      webLineGen,
      refLine,
      insLine,
      'output 형식: { "items": [ { "title": "...", "body": "...", "form": "④팁·정보형", "persona": "「호텔 사용설명서」", "hotels": [...], "matched": [ {"productId":"99500","productCode":"2gx2yiq8","hotel":"...","productName":"...","price":123000,"url":"https://...","status":"판매중"} ] } ] }',
    ].filter(Boolean).join('\n');
  }
  return jobs.createJob('content', {
    input: { mode: mode || 'generate', topic: topic || '', count: mode === 'match' ? 1 : (Number(count) || (mode === 'brief' ? 1 : 3)), perTopic: (mode === 'match' || mode === 'brief') ? 1 : per, forms: formList, scope, region: region || '', persona: persona || '', condition: cond, until: until || '', productCodes: productCodes || [], productTypes: productTypes || [], model: model === 'sonnet' ? 'sonnet' : 'opus', webSearch: web, bodyMin: bMin, bodyMax: bMax, brief: mode === 'brief' ? (brief || '') : '', userContent: mode === 'match' ? { title: userTitle || '', body: userBody || '' } : null },
    rules: { ...CONTENT_RULES, 본문: `${bodyRule}. 무엇이 좋은지 + 왜 이렇게 묶었는지를 고객 상황에서 와닿게. (스튜디오에서 지정한 본문 길이)` },
    referenceExamples: references,
    productCount: items.length,
    products: compactForJob(items),
    instructions,
    output: null,
  });
}

// ── 상품 조회 & 유형별 이미지 폴더 해석 ───────────────────────────────────────
function findProduct(code) {
  for (const s of ['domestic', 'overseas']) {
    const hit = crawl.normalizedItems(s).find((r) => r.productCode === code || (r.productId && r.productId === code));
    if (hit) return hit;
  }
  return null;
}
async function resolveProductImages(prod, { fresh }) {
  // 해외 패키지식(해외패키지/현지투어/패키지형 해외호텔) → 나라/도시 폴더
  if (prod.source === 'overseas' && !overseas.isHotelStyle(prod)) {
    const r = await overseas.resolveOverseas(syno, prod, { fresh });
    return { hotel: prod.region, ...r };
  }
  // 국내 또는 해외 호텔식(카드에 이모지 혜택) → 국내와 동일하게 호텔명으로 해석
  const resolved = await syno.resolveHotelImageDir(prod.hotel, { useCache: !fresh });
  const images = await syno.listImagesRecursive(resolved.imageDir);
  return { ...resolved, mode: prod.source === 'overseas' ? 'overseas-hotel' : 'domestic', count: images.length, images };
}

// ── 라우팅 ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  const q = u.searchParams;
  try {
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p);

    // ---- 상태/공통 ----
    if (p === '/api/state') return sendJson(res, 200, { state, nasReady: !!syno, datasets: { domestic: crawl.datasetInfo('domestic'), overseas: crawl.datasetInfo('overseas') } });
    if (p === '/api/themes') return sendJson(res, 200, THEME_PRESETS);
    if (p === '/api/product-types') return sendJson(res, 200, { types: productTypeList() });
    if (p === '/api/content/regions') { const scope = (q.get('scope') === 'overseas') ? 'overseas' : 'domestic'; return sendJson(res, 200, { scope, regions: regionList(scope) }); }
    if (p === '/api/content/type-counts') { const scope = (q.get('scope') === 'overseas') ? 'overseas' : 'domestic'; return sendJson(res, 200, typeCountsFor({ scope, region: q.get('region') || '', condition: q.get('condition') || 'selling', until: q.get('until') || '' })); }

    // ---- ① 크롤링 ----
    if (p === '/api/crawl' && req.method === 'POST') {
      const { scope = 'domestic' } = JSON.parse(await readBody(req) || '{}');
      if (!['domestic', 'overseas', 'both'].includes(scope)) return sendErr(res, 400, 'scope 오류');
      return sendJson(res, 200, { runId: startCrawl(scope) });
    }
    if (p === '/api/crawl/status') {
      const rec = runs.get(q.get('runId'));
      if (!rec) return sendErr(res, 404, 'runId 없음');
      return sendJson(res, 200, { running: rec.running, error: rec.error, log: rec.log, result: rec.result });
    }
    if (p === '/api/products') {
      const source = q.get('source') || 'domestic';
      const info = crawl.datasetInfo(source);
      if (!info) return sendJson(res, 200, { source, updatedAt: null, count: 0, rows: [] });
      return sendJson(res, 200, { source, updatedAt: info.updatedAt, count: info.count, csvFile: info.csvFile, rows: crawl.normalizedItems(source) });
    }
    if (p === '/api/products/download') {
      const source = q.get('source') || 'domestic';
      const info = crawl.datasetInfo(source);
      if (!info || !info.csvPath || !fs.existsSync(info.csvPath)) return sendErr(res, 404, 'CSV 없음(먼저 상품 불러오기)');
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(info.csvFile)}` });
      return safePipe(res, info.csvPath);
    }

    // ---- ② 콘텐츠 생성 (Claude Code 연동) ----
    if (p === '/api/content/generate' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!crawl.datasetInfo('domestic') && !crawl.datasetInfo('overseas')) return sendErr(res, 400, '먼저 상품을 불러오세요.');
      if (REF_SHARED && STUDIO_CFG.autoPull !== false) await gitPull(); // 최신 공유 모범 코퍼스로 생성
      if (body.mode === 'match' && !(body.userBody || '').trim()) return sendErr(res, 400, '매칭할 콘텐츠 본문을 입력하세요.');
      const job = buildContentJob(body);
      if (!job.productCount) return sendErr(res, 400, '조건에 맞는 상품이 없습니다. 조건/선택을 확인하세요.');
      const auto = dispatchToClaude(job.id, 'content');
      return sendJson(res, 200, { jobId: job.id, productCount: job.productCount, auto });
    }
    // 상품 선택 UI용: 필터 옵션(호텔/여행지·종류) + 전체 상품(경량)
    if (p === '/api/products/pick') {
      const rows = [...crawl.normalizedItems('domestic'), ...crawl.normalizedItems('overseas')]
        .map((r) => ({ productCode: r.productCode, productId: r.productId, source: r.source, hotel: r.hotel, region: r.region, type: r.type, name: r.name, price: r.price, status: r.status, nights: r.nights }));
      return sendJson(res, 200, { rows });
    }
    if (p === '/api/content/job') {
      const job = jobs.readJob(q.get('id'));
      if (!job) return sendErr(res, 404, 'job 없음');
      return sendJson(res, 200, { id: job.id, status: job.status, input: job.input, items: (job.output && job.output.items) || null, usage: job.usage || null });
    }
    // 콘텐츠 개별 저장(즐겨찾기)
    if (p === '/api/saved') {
      if (req.method === 'GET') return sendJson(res, 200, { items: categorizeSaved(loadSaved()) });
      if (req.method === 'POST') {
        const { item } = JSON.parse(await readBody(req) || '{}');
        if (!item || !item.title) return sendErr(res, 400, 'item(title) 필요');
        const id = contentKey(item);
        const arr = loadSaved().filter((x) => x.id !== id); // 같은 콘텐츠면 갱신
        arr.unshift({ ...item, id, savedAt: new Date().toISOString() });
        saveSaved(arr);
        return sendJson(res, 200, { id, count: arr.length });
      }
      if (req.method === 'DELETE') {
        const id = q.get('id');
        const arr = loadSaved().filter((x) => x.id !== id);
        saveSaved(arr);
        return sendJson(res, 200, { ok: true, count: arr.length });
      }
    }
    // 저장 콘텐츠 분류 수동 지정(미분류 → 국내/해외 재분류). 콘텐츠는 삭제하지 않고 category만 기록.
    if (p === '/api/saved/categorize' && req.method === 'POST') {
      const { id, category } = JSON.parse(await readBody(req) || '{}');
      if (!id || !['domestic', 'overseas', 'unknown'].includes(category)) return sendErr(res, 400, 'id·category(domestic|overseas|unknown) 필요');
      const arr = loadSaved();
      const it = arr.find((x) => x.id === id);
      if (!it) return sendErr(res, 404, '해당 저장 콘텐츠 없음');
      it.category = category;
      saveSaved(arr);
      return sendJson(res, 200, { ok: true, id, category });
    }
    // 저장 콘텐츠 학습 분석 시작
    if (p === '/api/saved/analyze' && req.method === 'POST') {
      const saved = loadSaved();
      if (saved.length < 2) return sendErr(res, 400, '학습 분석은 저장된 콘텐츠가 2편 이상일 때 가능해요.');
      const { model } = JSON.parse(await readBody(req) || '{}');
      const job = buildAnalyzeJob({ model });
      dispatchToClaude(job.id, 'analyze');
      return sendJson(res, 200, { id: job.id, count: saved.length });
    }
    // 저장 콘텐츠 학습 분석 상태 폴링(완료 시 insights/마크다운 수확)
    if (p.startsWith('/api/saved/analyze/') && req.method === 'GET') {
      const id = p.slice('/api/saved/analyze/'.length);
      const job = jobs.readJob(id);
      if (!job) return sendErr(res, 404, 'job 없음');
      if (job.status === 'done' && !job.harvested) harvestAnalyzeJob(job);
      return sendJson(res, 200, { id: job.id, status: job.status, usage: job.usage || null, insights: loadSavedInsights() });
    }
    // 현재 학습 분석 insights 조회
    if (p === '/api/saved/insights' && req.method === 'GET') return sendJson(res, 200, { insights: loadSavedInsights() });
    // 현재 사용자/담당자 상태
    if (p === '/api/me') return sendJson(res, 200, { user: currentUser(), isCurator: isCurator(), curationEnabled: curationEnabled(), shared: REF_SHARED, repoDir: REF_SHARED ? REF_DIR : null, curators: loadCurators() });
    // 최신 모범 받기(git pull)
    if (p === '/api/references/sync' && req.method === 'POST') { const ok = await gitPull(); return sendJson(res, 200, { ok, shared: REF_SHARED, items: loadReferences() }); }
    // 모범(참고) 콘텐츠 관리
    if (p === '/api/references') {
      if (req.method === 'GET') return sendJson(res, 200, { items: loadReferences(), isCurator: isCurator(), curationEnabled: curationEnabled() });
      if (req.method === 'POST') {
        if (!isCurator()) return sendErr(res, 403, '모범 콘텐츠 등록은 담당자(큐레이터)만 가능합니다.');
        const { item } = JSON.parse(await readBody(req) || '{}');
        if (!item || !(item.body || '').trim()) return sendErr(res, 400, '본문(body) 필요');
        if (REF_SHARED) await gitPull(); // 최신 상태에서 추가(충돌 최소화)
        const id = contentKey(item);
        const a = loadReferences().filter((x) => x.id !== id);
        a.unshift({ id, title: item.title || '', body: item.body, form: item.form || '', note: item.note || '', addedAt: new Date().toISOString(), addedBy: currentUser() });
        saveReferences(a);
        await gitCommitPush(`모범 추가: ${item.title || id} (${currentUser()})`);
        return sendJson(res, 200, { ok: true, id, count: a.length });
      }
      if (req.method === 'DELETE') {
        if (!isCurator()) return sendErr(res, 403, '담당자만 삭제할 수 있습니다.');
        saveReferences(loadReferences().filter((x) => x.id !== q.get('id')));
        await gitCommitPush(`모범 삭제 (${currentUser()})`);
        return sendJson(res, 200, { ok: true });
      }
    }
    // 예약 생성(스케줄) 관리
    if (p === '/api/schedules') {
      if (req.method === 'GET') return sendJson(res, 200, { schedules: loadSchedules(), serverTime: new Date().toISOString() });
      if (req.method === 'POST') {
        const b = JSON.parse(await readBody(req) || '{}');
        if (!b.time) return sendErr(res, 400, '시간(time) 필요');
        const sch = { id: crypto.randomBytes(4).toString('hex'), name: b.name || '예약 생성', cronType: b.cronType || 'weekly', dayOfWeek: b.dayOfWeek == null ? 1 : Number(b.dayOfWeek), time: b.time, date: b.date || '', params: b.params || {}, enabled: true, createdAt: new Date().toISOString(), lastRun: null, lastRunAt: null };
        const a = loadSchedules(); a.unshift(sch); saveSchedules(a);
        return sendJson(res, 200, { ok: true, schedule: sch });
      }
      if (req.method === 'DELETE') { const id = q.get('id'); saveSchedules(loadSchedules().filter((x) => x.id !== id)); return sendJson(res, 200, { ok: true }); }
    }
    if (p === '/api/schedules/toggle' && req.method === 'POST') {
      const { id, enabled } = JSON.parse(await readBody(req) || '{}');
      const a = loadSchedules(); const s = a.find((x) => x.id === id); if (s) { s.enabled = !!enabled; saveSchedules(a); }
      return sendJson(res, 200, { ok: !!s });
    }
    if (p === '/api/schedules/run' && req.method === 'POST') { // 지금 즉시 실행(테스트)
      const { id } = JSON.parse(await readBody(req) || '{}');
      const s = loadSchedules().find((x) => x.id === id); if (!s) return sendErr(res, 404, '예약 없음');
      const job = createScheduledJob(s);
      return sendJson(res, 200, { ok: true, jobId: job.id, productCount: job.productCount });
    }
    if (p === '/api/content/select' && req.method === 'POST') {
      const { item } = JSON.parse(await readBody(req) || '{}');
      if (!item) return sendErr(res, 400, 'item 필요');
      state.selectedContent = item;
      state.selectedProducts = [];
      state.selectedShowrooms = [];
      state.exposureType = 'goods';
      state.confirmedImages = [];
      state.matches = {};
      saveState(state);
      return sendJson(res, 200, { ok: true });
    }
    // 콘텐츠에 넣을 상품 선택 저장(구버전 호환 — 상품 노출)
    if (p === '/api/content/products' && req.method === 'POST') {
      const { products } = JSON.parse(await readBody(req) || '{}');
      state.selectedProducts = Array.isArray(products) ? products : [];
      state.exposureType = 'goods'; state.selectedShowrooms = [];
      state.matches = {};
      saveState(state);
      return sendJson(res, 200, { ok: true });
    }
    // 추천 쇼룸(정확 명칭) — 콘텐츠 매칭 상품을 크롤 데이터와 대조해 도출
    if (p === '/api/content/showrooms' && req.method === 'GET') {
      const c = state.selectedContent;
      if (!c) return sendErr(res, 400, '선택된 콘텐츠가 없습니다.');
      return sendJson(res, 200, { candidates: resolveShowrooms(c.matched || []) });
    }
    // 노출 종류(상품/쇼룸) + 선택 아이템 저장
    if (p === '/api/content/exposure' && req.method === 'POST') {
      const { exposureType, products, showrooms } = JSON.parse(await readBody(req) || '{}');
      state.exposureType = exposureType === 'showroom' ? 'showroom' : 'goods';
      state.selectedProducts = Array.isArray(products) ? products : [];
      state.selectedShowrooms = Array.isArray(showrooms) ? showrooms : [];
      state.matches = {};
      saveState(state);
      return sendJson(res, 200, { ok: true, exposureType: state.exposureType });
    }
    // 이미지↔상품 매칭 저장 (productCode → nasPath)
    if (p === '/api/content/matches' && req.method === 'POST') {
      const { matches } = JSON.parse(await readBody(req) || '{}');
      state.matches = matches && typeof matches === 'object' ? matches : {};
      saveState(state);
      return sendJson(res, 200, { ok: true });
    }
    // 상품 상세(자세히 팝업용) — productId로 전체 정규화 정보 조회
    if (p === '/api/product') {
      const id = q.get('id');
      if (!id) return sendErr(res, 400, 'id 필요');
      for (const src of ['domestic', 'overseas']) {
        const hit = crawl.normalizedItems(src).find((r) => r.productId === id);
        if (hit) return sendJson(res, 200, { product: hit });
      }
      return sendErr(res, 404, '상품 없음');
    }

    // ---- 이미지: 호텔 목록(크롤 데이터셋 기반) ----
    if (p === '/api/hotels') {
      const map = new Map();
      for (const r of crawl.normalizedItems('domestic')) if (r.hotel && !map.has(r.hotel)) map.set(r.hotel, { hotel: r.hotel, region: r.region, source: 'domestic' });
      for (const r of crawl.normalizedItems('overseas')) if (r.hotel && !map.has(r.hotel)) map.set(r.hotel, { hotel: r.hotel, region: r.region, source: 'overseas' });
      return sendJson(res, 200, { hotels: [...map.values()] });
    }

    // ---- ③ 이미지 찾기 (image-picker 로직 이식) ----
    if (p === '/api/images') {
      if (!requireSyno(res)) return;
      const hotel = q.get('hotel');
      const fresh = q.get('fresh') === '1';
      const root = q.get('root') || null;
      const productCode = q.get('productCode');
      // 상품 지정(+수동 root 아님)이면 상품 유형에 맞게 해석: 해외 패키지식은 나라/도시 폴더, 그 외는 호텔명.
      if (productCode && !root) {
        const prod = findProduct(productCode);
        if (prod) return sendJson(res, 200, await resolveProductImages(prod, { fresh }));
      }
      if (!hotel) return sendErr(res, 400, 'hotel 또는 productCode 필요');
      const resolved = await syno.resolveHotelImageDir(hotel, { useCache: !fresh && !root, root });
      const images = await syno.listImagesRecursive(resolved.imageDir);
      return sendJson(res, 200, { ...resolved, mode: 'domestic', count: images.length, images });
    }
    if (p === '/api/candidates') {
      if (!requireSyno(res)) return;
      const hotel = q.get('hotel');
      if (!hotel) return sendErr(res, 400, 'hotel 필요');
      const cands = await syno.collectRootCandidates(hotel);
      return sendJson(res, 200, { hotel, candidates: cands.slice(0, 12).map((c) => ({ name: c.name, path: c.path, score: Math.round(c.score * 100) / 100, parent: c.parent })) });
    }
    if (p === '/api/tree') {
      if (!requireSyno(res)) return;
      const dirPath = q.get('path');
      if (!dirPath) { const shares = await syno.listShares(); return sendJson(res, 200, { shares: shares.map((s) => ({ name: s.name, path: s.path })) }); }
      const files = await syno.list(dirPath, { onlyDirs: false });
      return sendJson(res, 200, { path: dirPath, dirs: files.filter((f) => f.isdir).map((f) => ({ name: f.name, path: f.path })), imageCount: files.filter((f) => !f.isdir && isImage(f.name)).length });
    }
    if (p === '/api/list-images') {
      if (!requireSyno(res)) return;
      const dirPath = q.get('path');
      if (!dirPath) return sendErr(res, 400, 'path 필요');
      const images = await syno.listImagesRecursive(dirPath);
      return sendJson(res, 200, { path: dirPath, count: images.length, images });
    }
    // 업로드 이미지 목록 / 업로드
    if (p === '/api/uploads' && req.method === 'GET') {
      let files = [];
      try { files = fs.readdirSync(UPLOADS).filter((f) => /\.(jpg|jpeg|png|webp|gif)$/i.test(f)); } catch {}
      return sendJson(res, 200, { images: files.map((f) => ({ path: 'upload:' + f, name: f, folder: '업로드', uploaded: true })) });
    }
    if (p === '/api/upload' && req.method === 'POST') {
      const { files = [] } = JSON.parse(await readBody(req) || '{}');
      fs.mkdirSync(UPLOADS, { recursive: true });
      const out = [];
      for (const f of files.slice(0, 30)) {
        const m = /^data:(image\/[a-z.+-]+);base64,(.+)$/i.exec(f.dataUrl || '');
        if (!m) continue;
        const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[m[1].toLowerCase()] || '.img';
        const id = crypto.randomBytes(6).toString('hex') + ext;
        try { fs.writeFileSync(path.join(UPLOADS, id), Buffer.from(m[2], 'base64')); out.push({ path: 'upload:' + id, name: f.name || id, folder: '업로드', uploaded: true }); } catch {}
      }
      return sendJson(res, 200, { images: out });
    }
    if (p === '/api/thumb') {
      const upPath = q.get('path');
      if (upPath && upPath.startsWith('upload:')) return serveUpload(res, upPath, false);
      if (!requireSyno(res)) return;
      const filePath = upPath;
      const size = q.get('size') || 'small';
      const mtime = q.get('mtime') || '';
      if (!filePath) return sendErr(res, 400, 'path 필요');
      const cacheFile = thumbCachePath(filePath, size, mtime);
      if (fs.existsSync(cacheFile)) { res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' }); return safePipe(res, cacheFile); }
      const r = await syno.thumb(filePath, size);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFile(cacheFile, buf, () => {});
      res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'max-age=86400' });
      return res.end(buf);
    }
    if (p === '/api/original') {
      const filePath = q.get('path');
      if (filePath && filePath.startsWith('upload:')) return serveUpload(res, filePath, true);
      if (!requireSyno(res)) return;
      if (!filePath) return sendErr(res, 400, 'path 필요');
      const r = await syno.download(filePath);
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}` });
      return res.end(buf);
    }

    // ---- ③-b Claude 이미지 추천 (job 핸드셰이크) ----
    if (p === '/api/images/export' && req.method === 'POST') {
      const { hotel, label, hotels, theme, body, items = null, paths = [], root = null, limit = 60 } = JSON.parse(await readBody(req) || '{}');
      const allItems = items && items.length ? items : (paths.length ? paths.map((pp) => ({ path: pp, hotel })) : null);
      const nasItems = allItems ? allItems.filter((i) => !String(i.path).startsWith('upload:')) : null;
      const uploadItems = allItems ? allItems.filter((i) => String(i.path).startsWith('upload:')) : [];
      if (!hotel && !(nasItems && nasItems.length) && !uploadItems.length) return sendErr(res, 400, 'hotel 또는 items 필요');
      fs.mkdirSync(EXPORTS, { recursive: true });
      let out;
      if (syno && (hotel || (nasItems && nasItems.length))) {
        out = await exportCandidates({ syno, hotel, label, hotels, theme, body, root, items: nasItems && nasItems.length ? nasItems.slice(0, limit) : null, limit, size: 'large', outRoot: EXPORTS });
      } else {
        // NAS 후보 없이 업로드 이미지만 추천할 때
        const { safeName } = require('../image-picker/exporter');
        const dirName = safeName(label || hotel || theme || '큐레이션');
        const dir = path.join(EXPORTS, dirName);
        if (fs.existsSync(dir)) { for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} } } else fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ label: dirName, theme, body, images: [], count: 0 }, null, 2));
        out = { dir, count: 0, label: dirName };
      }
      // 업로드 이미지 복사 + manifest 병합(추천 대상에 포함)
      if (uploadItems.length) {
        const manPath = path.join(out.dir, 'manifest.json');
        let man; try { man = JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch { man = { label: out.label, images: [] }; }
        man.images = man.images || [];
        let idx = man.images.length;
        for (const it of uploadItems.slice(0, limit)) {
          const id = path.basename(String(it.path).slice('upload:'.length));
          const src = path.join(UPLOADS, id);
          if (!fs.existsSync(src)) continue;
          const base = String(idx).padStart(3, '0') + '__업로드__' + id;
          try { fs.copyFileSync(src, path.join(out.dir, base)); man.images.push({ index: idx, file: base, hotel: it.hotel || null, folder: '업로드', name: id, nasPath: it.path }); idx++; } catch {}
        }
        man.count = man.images.length;
        fs.writeFileSync(manPath, JSON.stringify(man, null, 2));
        out.count = man.images.length;
      }
      const job = jobs.createJob('imagerec', {
        exportDir: out.dir, label: out.label, count: out.count,
        content: { title: theme || '', body: body || '' },
        instructions: [
          `이미지 추천 요청입니다. exportDir 폴더의 이미지들(large JPEG)을 Read로 직접 보고, 콘텐츠 주제 "${theme || ''}"에 어울리는 이미지를 순위대로 고르세요.`,
          '같은 폴더의 manifest.json 으로 파일명↔NAS경로↔호텔↔카테고리를 확인할 수 있습니다.',
          '완료되면 이 JSON 의 status 를 "done" 으로 바꾸고 output 을 채워 저장하세요.',
          'output 형식: { "picks": [ {"file":"000__호텔__카테고리__이름.jpg", "rank":1, "reason":"추천 이유 한 줄"} ] } (상위 6~8개).',
        ].join('\n'),
        output: null,
      });
      const auto = dispatchToClaude(job.id, 'imagerec');
      return sendJson(res, 200, { jobId: job.id, dir: out.dir, count: out.count, label: out.label, auto });
    }
    if (p === '/api/images/job') {
      const job = jobs.readJob(q.get('id'));
      if (!job) return sendErr(res, 404, 'job 없음');
      let picks = (job.output && job.output.picks) || null;
      if (picks && job.exportDir) {
        // manifest로 추천 파일 → NAS 경로 매핑(프론트 타일 하이라이트용)
        const man = loadJson(path.join(job.exportDir, 'manifest.json'));
        const byFile = new Map((man && man.images || []).map((m) => [m.file, m]));
        picks = picks.map((pk) => { const m = byFile.get(pk.file); return { ...pk, nasPath: m ? m.nasPath : null, hotel: m ? m.hotel : null, folder: m ? m.folder : null }; });
      }
      return sendJson(res, 200, { id: job.id, status: job.status, picks });
    }
    if (p === '/api/images/confirm' && req.method === 'POST') {
      const { images } = JSON.parse(await readBody(req) || '{}');
      if (!Array.isArray(images)) return sendErr(res, 400, 'images 배열 필요');
      state.confirmedImages = images;
      saveState(state);
      return sendJson(res, 200, { ok: true });
    }

    // ---- ⑤ 미리보기 ----
    if (p === '/api/preview') {
      const content = state.selectedContent;
      let products;
      if (state.exposureType === 'showroom') {
        products = (state.selectedShowrooms || []).map((s) => ({ productName: s.name, name: s.name, hotel: s.name, isShowroom: true, productCode: s.code || '', productId: s.code || '' }));
      } else {
        products = (state.selectedProducts && state.selectedProducts.length) ? state.selectedProducts : (content && content.matched) || [];
      }
      return sendJson(res, 200, { content, images: state.confirmedImages, products, matches: state.matches || {}, exposureType: state.exposureType || 'goods' });
    }

    // ---- ⑥ 발행(등록) ----
    // 미리보기에서 선택한 발행 형태 저장(2→off, 1→normal, 3→custom)
    if (p === '/api/publish/format' && req.method === 'POST') {
      const { mode } = JSON.parse(await readBody(req) || '{}');
      if (!['off', 'normal', 'custom'].includes(mode)) return sendErr(res, 400, "mode(off|normal|custom) 필요");
      state.publishFormat = mode; saveState(state);
      return sendJson(res, 200, { ok: true, mode });
    }
    // 현재 콘텐츠로 발행 초안 구성(미리채움)
    if (p === '/api/publish/draft' && req.method === 'GET') {
      const draft = buildPublishDraft();
      if (!draft) return sendErr(res, 400, '먼저 콘텐츠를 선택하세요(②~⑤ 단계).');
      return sendJson(res, 200, { draft });
    }
    // 발행 큐 CRUD
    if (p === '/api/publish/queue') {
      if (req.method === 'GET') return sendJson(res, 200, { items: loadPublishQueue() });
      if (req.method === 'POST') {
        const { item } = JSON.parse(await readBody(req) || '{}');
        if (!item) return sendErr(res, 400, 'item 필요');
        const arr = loadPublishQueue();
        if (item.id) { const i = arr.findIndex((x) => x.id === item.id); if (i >= 0) { arr[i] = { ...arr[i], ...item, updatedAt: new Date().toISOString() }; savePublishQueue(arr); return sendJson(res, 200, { id: item.id, count: arr.length }); } }
        const id = pubId();
        arr.unshift({ ...item, id, createdAt: new Date().toISOString(), status: item.status || 'draft' });
        savePublishQueue(arr);
        return sendJson(res, 200, { id, count: arr.length });
      }
      if (req.method === 'DELETE') { const id = q.get('id'); savePublishQueue(loadPublishQueue().filter((x) => x.id !== id)); return sendJson(res, 200, { ok: true }); }
    }
    // 아이템별 description 자동생성 시작/폴링
    if (p === '/api/publish/description' && req.method === 'POST') {
      const { items } = JSON.parse(await readBody(req) || '{}');
      if (!Array.isArray(items) || !items.length) return sendErr(res, 400, 'items 필요');
      const job = buildPublishDescJob(items);
      dispatchToClaude(job.id, 'pubdesc');
      return sendJson(res, 200, { id: job.id });
    }
    if (p.startsWith('/api/publish/description/') && req.method === 'GET') {
      const job = jobs.readJob(p.slice('/api/publish/description/'.length));
      if (!job) return sendErr(res, 404, 'job 없음');
      return sendJson(res, 200, { status: job.status, descriptions: (job.output && job.output.descriptions) || null });
    }
    // 발행 실행 — 스튜디오가 헤드리스(Playwright)로 백오피스에 직접 등록(버튼만 누르면 자동). 백그라운드 실행.
    if (p === '/api/publish/run' && req.method === 'POST') {
      const { id } = JSON.parse(await readBody(req) || '{}');
      const arr = loadPublishQueue(); const it = arr.find((x) => x.id === id);
      if (!it) return sendErr(res, 404, '항목 없음');
      it.status = 'publishing'; it.requestedAt = new Date().toISOString(); it.error = '';
      savePublishQueue(arr);
      runPublishJob(id); // 비동기 발행 시작(완료 시 status→published/failed)
      return sendJson(res, 200, { ok: true, id, status: 'publishing' });
    }
    // 발행 상태 갱신(자동화가 완료/실패 기록)
    if (p === '/api/publish/status' && req.method === 'POST') {
      const { id, status, postId, error } = JSON.parse(await readBody(req) || '{}');
      const arr = loadPublishQueue(); const it = arr.find((x) => x.id === id);
      if (!it) return sendErr(res, 404, '항목 없음');
      if (status) it.status = status;
      if (postId) it.backofficePostId = postId;
      if (error !== undefined) it.error = error;
      if (status === 'published') it.publishedAt = new Date().toISOString();
      savePublishQueue(arr);
      return sendJson(res, 200, { ok: true });
    }
    // 쇼룸 매핑 캐시(크롤명→백오피스 쇼룸ID/명) — 예외만 학습 저장(주기 스캔 불필요)
    if (p === '/api/publish/showroom-map') {
      const SHOWROOM_MAP_FILE = path.join(DIR, 'showroom-map.json');
      if (req.method === 'GET') return sendJson(res, 200, { map: loadJson(SHOWROOM_MAP_FILE) || {} });
      if (req.method === 'POST') {
        const { name, backofficeId, backofficeName } = JSON.parse(await readBody(req) || '{}');
        const m = loadJson(SHOWROOM_MAP_FILE) || {};
        if (name) { m[name] = { backofficeId: backofficeId || '', backofficeName: backofficeName || '', at: new Date().toISOString() }; fs.writeFileSync(SHOWROOM_MAP_FILE, JSON.stringify(m, null, 2)); }
        return sendJson(res, 200, { ok: true, map: m });
      }
    }
    // 발행 항목의 이미지를 로컬로 스테이징(B-2: 백오피스 파일 업로드 자동화용) — NAS/업로드 → publish-staging/<id>/
    if (p === '/api/publish/stage-images' && req.method === 'POST') {
      const { id } = JSON.parse(await readBody(req) || '{}');
      const it = loadPublishQueue().find((x) => x.id === id);
      if (!it) return sendErr(res, 404, '항목 없음');
      return sendJson(res, 200, await stageImagesFor(it));
    }
    // 발행 환경 상태(세션·Playwright 준비 여부) — UI 안내용
    if (p === '/api/publish/office-status' && req.method === 'GET') {
      const officeCfg = require('./_officecfg');
      let playwrightOk = false; try { require.resolve('playwright'); playwrightOk = true; } catch {}
      const sessionOk = fs.existsSync(officeCfg.sessionFile);
      return sendJson(res, 200, { playwrightOk, sessionOk, baseUrl: officeCfg.baseUrl });
    }
    // 백오피스 게시글 목록(캘린더용) — 60초 캐시. force=1이면 갱신
    if (p === '/api/office/posts' && req.method === 'GET') {
      const now = Date.now();
      const force = q.get('force') === '1';
      if (!force && officePostsCache.at && (now - officePostsCache.at) < 60000) return sendJson(res, 200, { posts: officePostsCache.posts, fetchedAt: officePostsCache.at, cached: true });
      try {
        const posts = await require('./office-posts').fetchOfficePosts();
        officePostsCache = { at: now, posts };
        return sendJson(res, 200, { posts, fetchedAt: now, cached: false });
      } catch (e) { return sendErr(res, 502, e.message); }
    }

    return sendErr(res, 404, 'unknown endpoint: ' + p);
  } catch (e) {
    console.error('[api error]', p, e.message);
    return sendErr(res, 500, e.message || 'internal error');
  }
});

server.listen(PORT, () => {
  console.log(`\n▶ PRIZM 콘텐츠 스튜디오: http://localhost:${PORT}`);
  console.log(`  NAS: ${nasCfg ? `${nasCfg.host}:${nasCfg.port || 5000} (읽기 전용)` : '미설정'}`);
  console.log(`  콘텐츠/이미지 AI: ${AUTO_CLAUDE ? `자동 호출 ON (${CLAUDE_BIN}, --model opus)` : '수동(문구 붙여넣기)'} · API키 불필요`);
  if (REF_SHARED) {
    console.log(`  모범 콘텐츠: 공유 저장소 ${REF_DIR} · 담당자 ${loadCurators().length}명 · 나(${currentUser()})=${isCurator() ? '등록가능' : '읽기전용'}`);
    if (STUDIO_CFG.autoPull !== false) gitPull().then((ok) => console.log(`  모범 코퍼스 동기화: ${ok ? '최신' : '실패(오프라인?)'}`));
  }
  console.log('');
});
