'use strict';
// 콘텐츠 이미지 추천기 — 프론트엔드 (무의존성)

const $ = (s) => document.querySelector(s);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

const state = {
  hotels: [],
  aiEnabled: false,
  images: [],        // {name, path, mtime, size}
  imageDir: null,
  activeKeywords: new Set(),
  selected: new Map(), // path -> {name, path}
  recMap: new Map(),   // path -> {score, reason, rank}
};

// 주제 키워드 사전(파일명 토큰 매칭용)
const KEYWORDS = [
  { label: '수영장', tokens: ['pool', '수영', '풀', 'infinity', '인피니티'] },
  { label: '오션뷰', tokens: ['ocean', 'sea', '바다', '오션', 'view', '뷰'] },
  { label: '객실', tokens: ['room', 'suite', '객실', '룸', '스위트', 'bed', '침대'] },
  { label: '조식/다이닝', tokens: ['breakfast', '조식', 'dining', '다이닝', 'restaurant', 'buffet', '뷔페', 'food', 'cafe'] },
  { label: '라운지/바', tokens: ['lounge', '라운지', 'bar', '바', 'club'] },
  { label: '야경/일몰', tokens: ['night', '야경', 'sunset', '일몰', '노을', 'evening'] },
  { label: '스파/사우나', tokens: ['spa', '스파', 'sauna', '사우나', 'onsen', '온천'] },
  { label: '외관/전경', tokens: ['exterior', '외관', 'facade', 'building', '전경', 'aerial'] },
  { label: '키즈/패밀리', tokens: ['kids', '키즈', 'family', '패밀리', 'child'] },
  { label: '로비', tokens: ['lobby', '로비', 'entrance', '입구'] },
];

// ── 초기화 ───────────────────────────────────────────────────────────────────
async function init() {
  const r = await fetch('/api/hotels').then((x) => x.json());
  state.hotels = r.hotels || [];
  state.aiEnabled = r.aiEnabled;
  renderHotelOptions('');
  buildKeywordChips();
  // API 자동추천 버튼은 키가 있을 때만 노출(기본 흐름은 "Claude에게 보내기")
  if (state.aiEnabled) $('#aiBtn').style.display = 'block';
  $('#status').textContent = `호텔 ${state.hotels.length}개 로드됨`;
  loadContentFiles();
  setupTabs();
  setupEvents();
}

function renderHotelOptions(q) {
  const sel = $('#hotelSelect');
  sel.innerHTML = '';
  const nq = q.trim().toLowerCase();
  state.hotels
    .filter((h) => !nq || h.hotel.toLowerCase().includes(nq))
    .slice(0, 300)
    .forEach((h) => {
      const o = el('option');
      o.value = h.hotel;
      o.textContent = `${h.hotel}  ·  ${h.region}`;
      sel.appendChild(o);
    });
}

function buildKeywordChips() {
  const box = $('#keywordChips');
  box.innerHTML = '';
  KEYWORDS.forEach((k) => {
    const c = el('span', 'chip');
    c.textContent = k.label;
    c.onclick = () => {
      if (state.activeKeywords.has(k.label)) state.activeKeywords.delete(k.label);
      else state.activeKeywords.add(k.label);
      c.classList.toggle('on');
      renderGallery();
    };
    box.appendChild(c);
  });
}

// ── 탭 ───────────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.tabpane').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $('#tab-' + t.dataset.tab).classList.add('active');
      state.activeTab = t.dataset.tab;
    };
  });
  state.activeTab = 'manual';
}

// ── 콘텐츠 md ────────────────────────────────────────────────────────────────
async function loadContentFiles() {
  const r = await fetch('/api/contents').then((x) => x.json());
  const sel = $('#mdFile');
  sel.innerHTML = '<option value="">— 파일 선택 —</option>';
  (r.files || []).forEach((f) => {
    const o = el('option'); o.value = f.file; o.textContent = f.name; sel.appendChild(o);
  });
  sel.onchange = async () => {
    const topics = $('#mdTopic');
    topics.innerHTML = '';
    if (!sel.value) return;
    const data = await fetch('/api/contents?file=' + encodeURIComponent(sel.value)).then((x) => x.json());
    (data.items || []).forEach((it, i) => {
      const o = el('option');
      o.value = String(i);
      o.textContent = it.title;
      o.dataset.hotels = JSON.stringify(it.hotels || []);
      o.dataset.body = it.body || '';
      o.dataset.title = it.title;
      topics.appendChild(o);
    });
    topics.onchange = () => {
      const opt = topics.selectedOptions[0];
      if (!opt) return;
      const hotels = JSON.parse(opt.dataset.hotels || '[]');
      state.mdHotels = hotels;
      const shown = hotels.slice(0, 20);
      $('#mdHotelHint').innerHTML = hotels.length
        ? `매칭 호텔 <b>${hotels.length}개</b>` + (hotels.length > 20 ? ' (많아서 앞 20개만 로드)' : '') +
          ': ' + shown.map((h) => `<b>${h}</b>`).join(', ') +
          '<br>“이미지 검색”을 누르면 이 호텔들을 <b>큐레이션으로 함께</b> 불러옵니다.'
        : '이 주제에 매칭된 호텔명을 찾지 못했습니다. “호텔 직접 선택” 탭을 이용하세요.';
      // 주제 텍스트를 입력란에도 반영(추천 컨텍스트)
      $('#themeInput').value = opt.dataset.title || '';
      $('#bodyInput').value = opt.dataset.body || '';
    };
  };
}

// ── 현재 입력값 ──────────────────────────────────────────────────────────────
// 다중 호텔: md 탭에서 주제를 고르면 그 주제의 매칭 호텔들, 아니면 셀렉트에서 선택한 호텔들.
function currentHotels() {
  if (state.activeTab === 'md' && state.mdHotels && state.mdHotels.length) {
    return state.mdHotels.slice(0, 20);
  }
  return [...$('#hotelSelect').selectedOptions].map((o) => o.value).filter(Boolean);
}
function currentHotel() { return currentHotels()[0] || ''; }
function currentTheme() { return $('#themeInput').value.trim(); }
function currentBody() { return $('#bodyInput').value.trim(); }

// ── 이미지 로드 (단일/다중 호텔) ──────────────────────────────────────────────
async function loadImages(fresh = false, root = null) {
  const hotels = currentHotels();
  if (!hotels.length) { alert('호텔을 선택하세요. (여러 개 선택 시 큐레이션으로 함께 불러옵니다)'); return; }
  const multi = hotels.length > 1;
  state.multi = multi;
  state.images = [];
  state.recMap.clear();
  $('#galleryInfo').textContent = '';
  const infos = [];
  let firstData = null;

  for (let i = 0; i < hotels.length; i++) {
    const h = hotels[i];
    $('#resolveInfo').innerHTML = `<span class="spinner"></span> (${i + 1}/${hotels.length}) ${h} 폴더 찾는 중…`;
    try {
      const qs = `hotel=${encodeURIComponent(h)}${fresh ? '&fresh=1' : ''}${(!multi && root) ? '&root=' + encodeURIComponent(root) : ''}`;
      const data = await fetch(`/api/images?${qs}`).then((x) => x.json());
      if (data.error) { infos.push(`<span class="warn">${h}: ${data.error}</span>`); continue; }
      (data.images || []).forEach((im) => { im.hotel = h; });
      state.images.push(...(data.images || []));
      const flag = data.confident === false ? ' <span class="warn">⚠확신낮음</span>' : (data.usedFallback ? ' (취합)' : '');
      infos.push(`<b>${h}</b> ${data.count}장${flag}`);
      if (i === 0) firstData = data;
    } catch (e) {
      infos.push(`<span class="warn">${h}: ${e.message}</span>`);
    }
  }

  $('#resolveInfo').innerHTML = infos.join('<br>') + (multi ? `<br>합계 <b>${state.images.length}</b>장 · ${hotels.length}개 호텔` : '');

  // 단일 호텔이면 후보/트리(수동 보정) UI 제공, 다중이면 생략
  if (!multi && firstData) {
    renderCandidates(firstData.candidates, firstData.confident === false || firstData.usedFallback);
    loadTree(firstData.root);
  } else {
    $('#candBox').innerHTML = '';
    $('#treeView').innerHTML = '<div class="hint">다중 호텔 모드에서는 폴더 수동보정을 생략합니다. 호텔 1개만 선택하면 사용할 수 있어요.</div>';
  }
  renderGallery();
}

// “혹시 이 폴더?” 후보 렌더링(신뢰도 낮을 때 자동, 항상 조회 가능)
function renderCandidates(candidates, forceOpen) {
  const box = $('#candBox');
  if (!candidates || !candidates.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="hint" style="margin-top:8px">혹시 이 폴더인가요? (클릭하면 그 폴더로 다시 검색)</div>';
  candidates.slice(0, 8).forEach((c) => {
    const b = el('button', 'candbtn');
    b.innerHTML = `<b>${Math.round(c.score * 100)}%</b> ${c.name}` + (c.parent ? ` <span class="cnt">(${c.parent})</span>` : '');
    b.title = c.path;
    b.onclick = () => loadImages(false, c.path);
    box.appendChild(b);
  });
  if (forceOpen) box.scrollIntoView({ block: 'nearest' });
}

async function loadCandidates(hotel) {
  try {
    const d = await fetch('/api/candidates?hotel=' + encodeURIComponent(hotel)).then((x) => x.json());
    renderCandidates(d.candidates, true);
  } catch { /* ignore */ }
}

// ── 갤러리(지연로딩) ─────────────────────────────────────────────────────────
let io;
function renderGallery() {
  const g = $('#gallery');
  g.innerHTML = '';
  if (io) io.disconnect();
  io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        const img = en.target;
        if (img.dataset.src) { img.src = img.dataset.src; img.removeAttribute('data-src'); }
        io.unobserve(img);
      }
    });
  }, { rootMargin: '300px' });

  let list = state.images.slice();
  // 키워드 필터
  if (state.activeKeywords.size) {
    list = list.filter((im) => matchesKeywords(im));
  }
  // AI 추천이 있으면 추천 순 → 점수 정렬
  if (state.recMap.size) {
    list.sort((a, b) => (state.recMap.get(b.path)?.score || -1) - (state.recMap.get(a.path)?.score || -1));
  }

  $('#galleryInfo').textContent = state.images.length
    ? `${list.length} / ${state.images.length}장 표시` + (state.recMap.size ? ' · AI 추천 상단 정렬' : '')
    : '이미지가 없습니다.';

  list.forEach((im) => g.appendChild(tile(im)));
}

function matchesKeywords(im) {
  // 파일명은 무의미(_MG_6172.jpg)한 경우가 많아 카테고리 폴더명까지 함께 매칭
  const n = ((im.folder || '') + ' ' + (im.name || '')).toLowerCase();
  for (const label of state.activeKeywords) {
    const k = KEYWORDS.find((x) => x.label === label);
    if (k && k.tokens.some((t) => n.includes(t.toLowerCase()))) return true;
  }
  return false;
}

function tile(im) {
  const t = el('div', 'tile');
  const rec = state.recMap.get(im.path);
  if (state.selected.has(im.path)) t.classList.add('sel');
  if (rec) t.classList.add('rec');

  const img = el('img');
  img.dataset.src = `/api/thumb?path=${encodeURIComponent(im.path)}&size=small&mtime=${im.mtime || ''}`;
  img.loading = 'lazy';
  t.appendChild(img);
  io.observe(img);

  if (rec) {
    const b = el('div', 'badge'); b.textContent = `AI ${rec.score}`; t.appendChild(b);
    if (rec.reason) { const rz = el('div', 'reason'); rz.textContent = rec.reason; t.appendChild(rz); }
  } else {
    const nm = el('div', 'name'); nm.textContent = im.folder ? `${im.folder} · ${im.name}` : im.name; t.appendChild(nm);
  }
  if (im.folder) { const cat = el('div', 'cat'); cat.textContent = im.folder; t.appendChild(cat); }
  if (state.multi && im.hotel) { const ht = el('div', 'hotel'); ht.textContent = im.hotel; t.appendChild(ht); }
  const ck = el('div', 'check'); ck.textContent = '✓'; t.appendChild(ck);

  t.onclick = (e) => {
    if (e.shiftKey) return openLightbox(im);
    toggleSelect(im, t);
  };
  t.ondblclick = () => openLightbox(im);
  return t;
}

function toggleSelect(im, tileEl) {
  if (state.selected.has(im.path)) state.selected.delete(im.path);
  else state.selected.set(im.path, { name: im.name, path: im.path, hotel: im.hotel, folder: im.folder });
  tileEl.classList.toggle('sel');
  renderSelected();
}

function renderSelected() {
  $('#selCount').textContent = state.selected.size;
  const box = $('#selectedList');
  box.innerHTML = '';
  state.selected.forEach((im) => {
    const img = el('img', 'th');
    img.src = `/api/thumb?path=${encodeURIComponent(im.path)}&size=small`;
    img.title = im.name;
    img.onclick = () => { state.selected.delete(im.path); renderSelected(); renderGallery(); };
    box.appendChild(img);
  });
}

// ── 라이트박스 ───────────────────────────────────────────────────────────────
function openLightbox(im) {
  $('#lightboxImg').src = `/api/thumb?path=${encodeURIComponent(im.path)}&size=large`;
  $('#lbDownload').href = `/api/original?path=${encodeURIComponent(im.path)}`;
  $('#lightbox').classList.remove('hidden');
}

// ── Claude에게 보내기(로컬 폴더로 저장, API 키 불필요) ────────────────────────
function currentCandidatePaths() {
  const cand = state.activeKeywords.size ? state.images.filter((im) => matchesKeywords(im)) : state.images;
  return cand.slice(0, 40).map((im) => im.path);
}

async function runExport() {
  if (!state.images.length) { alert('먼저 이미지를 불러오세요.'); return; }
  const btn = $('#sendBtn');
  btn.disabled = true;
  $('#sendNote').innerHTML = '<span class="spinner"></span> 썸네일을 로컬 폴더로 내려받는 중…';
  try {
    // 선택한 게 있으면 그것만, 없으면 (필터된) 전체 후보
    const source = state.selected.size
      ? [...state.selected.values()]
      : (state.activeKeywords.size ? state.images.filter((im) => matchesKeywords(im)) : state.images);
    const items = source.slice(0, 60).map((im) => ({ path: im.path, hotel: im.hotel, folder: im.folder }));
    const hotels = currentHotels();
    const multi = hotels.length > 1;
    const label = multi ? (currentTheme() || '큐레이션') : currentHotel();
    const r = await fetch('/api/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, hotel: currentHotel(), hotels, theme: currentTheme(), body: currentBody(), items }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '실패');
    const ask = `${data.dir} 사진들 중 "${currentTheme() || '이 콘텐츠'}"에 어울리는 이미지 추천해줘`;
    $('#sendNote').innerHTML =
      `✅ <b>${data.count}장</b> 저장됨<br><code style="font-size:11px">${data.dir}</code><br>` +
      `아래 문장을 <b>Claude Code 채팅</b>에 붙여넣으세요:` +
      `<div class="askbox" id="askbox">${ask}</div>` +
      `<button id="copyAsk" style="margin-top:6px">문장 복사</button>`;
    $('#copyAsk').onclick = () => navigator.clipboard.writeText(ask).then(() => { $('#copyAsk').textContent = '복사됨 ✓'; });
  } catch (e) {
    $('#sendNote').innerHTML = `<span style="color:var(--accent)">${e.message}</span>`;
  } finally {
    btn.disabled = false;
  }
}

// ── (선택) API 자동 추천 — 키 설정 시에만 ────────────────────────────────────
async function runAi() {
  if (!state.images.length) { alert('먼저 이미지를 불러오세요.'); return; }
  const btn = $('#aiBtn');
  btn.disabled = true;
  $('#aiNote').innerHTML = '<span class="spinner"></span> Claude가 후보 사진을 살펴보는 중…';
  // 필터가 걸려 있으면 필터된 것만, 아니면 앞 30장을 후보로
  let cand = state.activeKeywords.size ? state.images.filter((im) => matchesKeywords(im)) : state.images;
  const paths = cand.slice(0, 30).map((im) => im.path);
  try {
    const r = await fetch('/api/recommend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hotel: currentHotel(), theme: currentTheme(), body: currentBody(), paths, topN: 8 }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '실패');
    state.recMap.clear();
    (data.ranked || []).forEach((rec, i) => state.recMap.set(rec.path, { ...rec, rank: i + 1 }));
    $('#aiNote').textContent = data.note
      ? data.note
      : `추천 ${state.recMap.size}장 · 상단 파란 테두리`;
    renderGallery();
  } catch (e) {
    $('#aiNote').innerHTML = `<span style="color:var(--accent)">${e.message}</span>`;
  } finally {
    btn.disabled = false;
  }
}

// ── 폴더 트리(수동 드릴다운) ─────────────────────────────────────────────────
async function loadTree(dirPath) {
  const view = $('#treeView');
  view.innerHTML = '<span class="spinner"></span>';
  try {
    const data = await fetch('/api/tree?path=' + encodeURIComponent(dirPath)).then((x) => x.json());
    view.innerHTML = '';
    const head = el('div', 'row');
    head.innerHTML = `<span class="up">📁 ${dirPath}</span><span class="use" title="이 폴더 이미지 사용">이미지 ${data.imageCount || 0}장 · 사용</span>`;
    head.querySelector('.use').onclick = () => useFolder(dirPath);
    view.appendChild(head);
    (data.dirs || []).forEach((d) => {
      const row = el('div', 'row');
      row.innerHTML = `<span>📂 ${d.name}</span><span class="cnt">›</span>`;
      row.onclick = () => loadTree(d.path);
      view.appendChild(row);
    });
  } catch (e) {
    view.innerHTML = `<span style="color:var(--accent)">${e.message}</span>`;
  }
}

async function useFolder(dirPath) {
  const data = await fetch('/api/list-images?path=' + encodeURIComponent(dirPath)).then((x) => x.json());
  state.images = data.images || [];
  state.imageDir = dirPath;
  state.recMap.clear();
  $('#resolveInfo').innerHTML = `직접 선택한 폴더: <b>${dirPath}</b><br>이미지 <b>${data.count}</b>장`;
  renderGallery();
}

// ── 이벤트 바인딩 ────────────────────────────────────────────────────────────
function setupEvents() {
  $('#hotelSearch').oninput = (e) => renderHotelOptions(e.target.value);
  $('#hotelSelect').onchange = () => {
    const n = currentHotels().length;
    $('#hotelSelCount').textContent = n > 1 ? `${n}개 호텔 선택됨 (큐레이션 모드)` : '';
  };
  $('#loadBtn').onclick = () => loadImages(false);
  $('#sendBtn').onclick = runExport;
  $('#aiBtn').onclick = runAi;
  $('#lbClose').onclick = () => $('#lightbox').classList.add('hidden');
  $('#lightbox').onclick = (e) => { if (e.target.id === 'lightbox') $('#lightbox').classList.add('hidden'); };
  $('#exportBtn').onclick = () => {
    const text = [...state.selected.values()].map((im) => im.path).join('\n');
    if (!text) return alert('선택된 이미지가 없습니다.');
    navigator.clipboard.writeText(text).then(() => alert(`경로 ${state.selected.size}개를 복사했습니다.`));
  };
  $('#dlBtn').onclick = downloadSelected;
}

// 선택한 이미지의 원본을 브라우저 다운로드 폴더로 하나씩 내려받는다.
async function downloadSelected() {
  const items = [...state.selected.values()];
  if (!items.length) return alert('선택된 이미지가 없습니다.');
  const btn = $('#dlBtn');
  btn.disabled = true;
  for (let i = 0; i < items.length; i++) {
    $('#dlNote').innerHTML = `<span class="spinner"></span> 원본 다운로드 ${i + 1}/${items.length}…`;
    const a = document.createElement('a');
    a.href = `/api/original?path=${encodeURIComponent(items[i].path)}`;
    a.download = items[i].name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 500)); // 브라우저 다중 다운로드 완화
  }
  $('#dlNote').textContent = `✅ ${items.length}장 다운로드 시작됨 (브라우저 다운로드 폴더 확인). "다중 다운로드 허용"이 뜨면 허용하세요.`;
  btn.disabled = false;
}

init();
