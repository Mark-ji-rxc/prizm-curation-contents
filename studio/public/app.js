'use strict';
// PRIZM 콘텐츠 스튜디오 — 프론트엔드
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (path, opts) => { const r = await fetch(path, opts); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 본문 렌더: 추측성(미검증) 문장(speculative[])을 다른 색으로 표기. body는 원문 그대로 저장/등록됨.
function specHtml(text, spec) {
  let h = esc(text || '');
  (spec || []).forEach((s) => { const e = esc(String(s || '').trim()); if (e && h.includes(e)) h = h.split(e).join('<span class="spec-txt" title="추측성(미검증)">' + e + '</span>'); });
  return h;
}
const won = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('ko-KR') + '원');

let productSource = 'domestic';
let selectedContent = null;      // {title, body, form, persona, matched:[...]}
let galleryImages = [];          // [{path, name, folder, mtime, hotel}]
const selectedTiles = new Map(); // path -> imageObj
let recPicks = null;             // [{file, nasPath, rank, reason}]
const selectedProducts = new Map(); // productId -> matched item (③ 상품 선택)
const selectedShowrooms = new Map(); // name -> {name,kind,code,hotel,region,products} (③ 쇼룸 선택)
let exposureType = 'goods'; // 'goods'(상품 노출) | 'showroom'(쇼룸 노출)

// ── 단계 네비 ────────────────────────────────────────────────────────────────
function goStep(n) {
  $$('.step').forEach((b) => b.classList.toggle('active', b.dataset.step == n));
  $$('.panel').forEach((s) => s.classList.toggle('active', s.dataset.panel == n));
  if (n == 5) renderPreviews();
  if (n == 6) renderPublishStep();
  if (n == 'cal') loadCalendar();
}
$('#steps').addEventListener('click', (e) => { const b = e.target.closest('.step'); if (b) goStep(b.dataset.step); });
function markDone(n) { const b = $(`.step[data-step="${n}"]`); if (b) b.classList.add('done'); }

// ── ① 크롤링 ─────────────────────────────────────────────────────────────────
async function runCrawl(scope) {
  const log = $('#crawlLog'); log.classList.remove('hidden'); log.textContent = '요청 전송…';
  $$('#crawlDomestic,#crawlOverseas,#crawlBoth').forEach((b) => (b.disabled = true));
  try {
    const { runId } = await api('/api/crawl', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope }) });
    await pollCrawl(runId, log);
  } catch (e) { log.textContent = '오류: ' + e.message; }
  $$('#crawlDomestic,#crawlOverseas,#crawlBoth').forEach((b) => (b.disabled = false));
  loadProducts();
}
function pollCrawl(runId, log) {
  return new Promise((resolve) => {
    const t = setInterval(async () => {
      try {
        const s = await api('/api/crawl/status?runId=' + runId);
        log.textContent = s.log.join('\n'); log.scrollTop = log.scrollHeight;
        if (!s.running) { clearInterval(t); markDone(1); resolve(); }
      } catch (e) { clearInterval(t); resolve(); }
    }, 800);
  });
}
$('#crawlDomestic').onclick = () => runCrawl('domestic');
$('#crawlOverseas').onclick = () => runCrawl('overseas');
$('#crawlBoth').onclick = () => runCrawl('both');

$('#productTabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (!b) return; productSource = b.dataset.source; $$('#productTabs .tab').forEach((x) => x.classList.toggle('active', x === b)); loadProducts(); });
$('#downloadCsv').onclick = (e) => { e.preventDefault(); location.href = '/api/products/download?source=' + productSource; };
['#productFilter', '#fRegion', '#fNights', '#fStatus', '#fPriceMin', '#fPriceMax'].forEach((sel) => $(sel).addEventListener('input', renderProducts));
$('#fReset').onclick = () => { ['#productFilter', '#fPriceMin', '#fPriceMax', '#fRegion', '#fNights', '#fStatus'].forEach((s) => ($(s).value = '')); renderProducts(); };

let productRows = [];
let productUpdatedAt = '';
function fillSelect(sel, values, label) {
  const cur = $(sel).value;
  $(sel).innerHTML = `<option value="">${label}</option>` + values.map((v) => `<option>${esc(v)}</option>`).join('');
  if (values.includes(cur)) $(sel).value = cur;
}
async function loadProducts() {
  const meta = $('#productMeta');
  try {
    const d = await api('/api/products?source=' + productSource);
    productRows = d.rows || [];
    productUpdatedAt = d.updatedAt || '';
    const uniq = (k) => [...new Set(productRows.map((r) => r[k]).filter((v) => v !== '' && v != null))];
    // 박수는 숫자/문자 혼재 → 대략 정렬
    fillSelect('#fRegion', uniq('region').sort((a, b) => a.localeCompare(b, 'ko')), productSource === 'overseas' ? '지역명 전체' : '지역 전체');
    fillSelect('#fNights', uniq('nights').sort(), '박수 전체');
    fillSelect('#fStatus', uniq('status').sort(), '상태 전체');
    renderProducts();
  } catch (e) { meta.textContent = '오류: ' + e.message; }
}
function currentFiltered() {
  const kw = $('#productFilter').value.trim();
  const region = $('#fRegion').value, nights = $('#fNights').value, status = $('#fStatus').value;
  const min = parseFloat($('#fPriceMin').value), max = parseFloat($('#fPriceMax').value);
  return productRows.filter((r) => {
    if (kw && !(`${r.hotel} ${r.name} ${r.type} ${r.productCode} ${r.productId}`).includes(kw)) return false;
    if (region && r.region !== region) return false;
    if (nights && r.nights !== nights) return false;
    if (status && r.status !== status) return false;
    const p = Number(r.price) || 0;
    if (!isNaN(min) && p < min) return false;
    if (!isNaN(max) && p > max) return false;
    return true;
  });
}
function renderProducts() {
  const rows = currentFiltered();
  $('#productMeta').textContent = productRows.length
    ? `${rows.length.toLocaleString()} / ${productRows.length.toLocaleString()}개${productUpdatedAt ? ' · 업데이트 ' + new Date(productUpdatedAt).toLocaleString('ko-KR') : ''}`
    : '데이터 없음 — 업데이트 버튼을 누르세요.';
  const isOv = productSource === 'overseas';
  const head = isOv ? ['상품ID', '상품코드', '상품구분', '상품명', '박수', '판매가', '상태', ''] : ['상품ID', '상품코드', '호텔명', '지역', '상품명', '박수', '판매가', '상태', ''];
  $('#productTable thead').innerHTML = '<tr>' + head.map((h) => `<th>${h}</th>`).join('') + '</tr>';
  const shown = rows.slice(0, 800);
  $('#productTable tbody').innerHTML = shown.map((r, i) => {
    const st = r.status === '판매중' ? 'ok' : 'warn';
    const stCell = `<span class="badge ${st}">${esc(r.status)}${r.soldout ? '·매진' : ''}</span>`;
    const btn = `<button class="detail-btn" data-i="${i}">자세히</button>`;
    const idCell = `<td><code>${esc(r.productId || '-')}</code></td><td><code>${esc(r.productCode || '-')}</code></td>`;
    if (isOv) return `<tr>${idCell}<td>${esc(r.type)}</td><td>${esc(r.name)}</td><td>${esc(r.nights)}</td><td>${won(r.price)}</td><td>${stCell}</td><td>${btn}</td></tr>`;
    return `<tr>${idCell}<td>${esc(r.hotel)}</td><td>${esc(r.region)}</td><td>${esc(r.name)}</td><td>${esc(r.nights)}</td><td>${won(r.price)}</td><td>${stCell}</td><td>${btn}</td></tr>`;
  }).join('');
  $$('#productTable .detail-btn').forEach((btn) => (btn.onclick = () => openProductModal(shown[+btn.dataset.i])));
}
function openProductModal(r) {
  if (!r) return;
  const isOv = r.source === 'overseas';
  const secs = isOv
    ? `<div class="sec"><b>기본 정보</b><pre class="pkg">${esc(r.baseInfo || '(정보 없음)')}</pre></div>
       <div class="sec"><b>단독 구성</b><pre class="pkg">${esc(r.exclusive || '(정보 없음)')}</pre></div>`
    : `<div class="sec"><b>PKG 혜택 (패키지 포함내역)</b><pre class="pkg">${esc(r.detail || '(정보 없음)')}</pre></div>`;
  const persons = (r.maxPersons || r.basePersons) ? `<div class="sub">투숙 인원 · 기준 ${esc(r.basePersons || '-')} / <b>최대 ${esc(r.maxPersons || '-')}</b></div>` : '';
  $('#productModalBody').innerHTML = `
    <h3>${esc(r.name)}</h3>
    <div class="sub">${isOv ? esc(r.type) : esc(r.hotel) + ' · ' + esc(r.region)} · 상품ID <code>${esc(r.productId || '-')}</code> · 코드 <code>${esc(r.productCode || '-')}</code> · ${won(r.price)} · ${esc(r.status)}</div>
    ${persons}
    ${secs}
    <div class="sec"><a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">PRIZM에서 상품 열기 </a></div>`;
  $('#productModal').classList.remove('hidden');
}
$('#productModal').addEventListener('click', (e) => { if (e.target.id === 'productModal' || e.target.classList.contains('modal-close')) $('#productModal').classList.add('hidden'); });

// ── ② 콘텐츠 생성 ────────────────────────────────────────────────────────────
async function loadThemes() {
  try {
    const t = await api('/api/themes');
    const render = () => {
      const scope = $('#cScope').value;
      $('#themePresets').innerHTML = (t[scope] || []).map((x) => `<span class="chip">${esc(x)}</span>`).join('');
    };
    render();
    $('#cScope').addEventListener('change', () => { render(); renderTypeChips(); loadRegions(); }); // 구분 바뀌면 상품 타입 칩·지역 목록 재필터
    $('#themePresets').addEventListener('click', (e) => { if (e.target.classList.contains('chip')) $('#cTopic').value = e.target.textContent; });
  } catch {}
}
// 지역 드롭다운: 선택 구분(국내/해외)에 존재하는 지역만. 해외는 서버가 도시/지역으로 정규화(푸꾸옥·나트랑·방콕·일본 등).
async function loadRegions() {
  const sel = $('#cRegion'); if (!sel) return;
  const scope = $('#cScope').value;
  const prev = sel.value;
  try {
    const { regions } = await api('/api/content/regions?scope=' + encodeURIComponent(scope));
    const opts = ['<option value="">전체</option>'].concat((regions || []).map((r) => `<option value="${esc(r.region)}">${esc(r.region)} (${r.count})</option>`));
    sel.innerHTML = opts.join('');
    sel.value = regions.some((r) => r.region === prev) ? prev : ''; // 구분 바뀌면 없는 지역은 전체로
  } catch { sel.innerHTML = '<option value="">전체</option>'; }
  refreshTypeCounts(); // 지역 목록 갱신 후 타입 수도 재계산
}
$('#cRegion').addEventListener('change', refreshTypeCounts);
$('#cCondition').addEventListener('change', () => { $('#cUntilWrap').classList.toggle('hidden', $('#cCondition').value !== 'until'); refreshTypeCounts(); });
$('#cUntil').addEventListener('change', refreshTypeCounts);

// 생성 모드 토글(주제 자동 생성 / 내 콘텐츠 매칭)
let genMode = 'generate';
$('#genModeTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.mtab'); if (!b) return;
  genMode = b.dataset.mode;
  $$('#genModeTabs .mtab').forEach((x) => x.classList.toggle('active', x === b));
  $('#genFields').classList.toggle('hidden', genMode !== 'generate');
  $('#matchFields').classList.toggle('hidden', genMode !== 'match');
  $('#briefFields').classList.toggle('hidden', genMode !== 'brief');
});

// 상품 직접 선택(피커) — 선택 시 그 상품들로만 생성/매칭
const pickCodes = new Set();
let pickerRows = [];
// 본문 글자수 범위(프리셋 "min-max" 또는 직접 입력). 기본 100~300.
function bodyLenValues() {
  const v = ($('#cBodyLen') && $('#cBodyLen').value) || '100-300';
  if (v === 'custom') return { bodyMin: Number($('#cBodyMin').value) || 100, bodyMax: Number($('#cBodyMax').value) || 300 };
  const [a, b] = v.split('-').map(Number);
  return { bodyMin: a || 100, bodyMax: b || 300 };
}
$('#cBodyLen') && $('#cBodyLen').addEventListener('change', () => { $('#cBodyLenCustom').classList.toggle('hidden', $('#cBodyLen').value !== 'custom'); });
function regionModeOn() { return !!($('#cRegionMode') && $('#cRegionMode').checked); }
function commonBody() {
  const region = regionModeOn();
  const b = { scope: $('#cScope').value, region: $('#cRegion').value.trim(), condition: $('#cCondition').value, until: $('#cUntil').value, webSearch: region ? true : $('#cWeb').checked, model: $('#cModel').value, regionMode: region, ...bodyLenValues() };
  if (!region && pickCodes.size) b.productCodes = [...pickCodes];   // 지역모드는 상품 조건 무시
  if (!region && selTypes.size) b.productTypes = [...selTypes];
  return b;
}
// 지역 기반 콘텐츠 토글: 웹검색 강제 ON+잠금, 상품 관련 UI 흐리게, 생성 게이트 갱신
$('#cRegionMode') && $('#cRegionMode').addEventListener('change', () => {
  const on = $('#cRegionMode').checked;
  const web = $('#cWeb'); if (web) { if (on) { web.checked = true; web.disabled = true; } else { web.disabled = false; } }
  const ps = $('#productScope'); if (ps) ps.classList.toggle('dimmed', on);
  updateGenGate();
});
async function submitGeneration(extra) {
  if (typeTotal === 0 && !pickCodes.size && !regionModeOn()) return alert('선택한 지역·판매조건에 해당하는 상품이 없어 콘텐츠를 생성할 수 없어요. 조건을 바꿔주세요.');
  const body = { ...commonBody(), ...extra };
  // 생성 scope로 분류를 미리 기록: 국내 생성=국내 호텔, 해외 생성=해외 여행상품.
  // 단, 상품 타입/직접선택은 양쪽 데이터셋을 넘나들 수 있어 매칭 상품으로 서버가 판정하도록 비워둠.
  const stampCat = (body.productCodes && body.productCodes.length) || (body.productTypes && body.productTypes.length)
    ? null : (body.scope === 'overseas' ? 'overseas' : 'domestic');
  const banner = $('#contentJobBanner');
  banner.classList.remove('hidden'); banner.innerHTML = '<span class="spinner"></span> 요청 생성 중…';
  try {
    const { jobId, productCount, auto } = await api('/api/content/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const scopeNote = pickCodes.size ? `선택 상품 ${productCount}개` : `상품 ${productCount}개`;
    const total = (Number(body.count) || 0) * (Number(body.perTopic) || 1);
    const web = body.webSearch ? ' · 검색' : '';
    const note = extra.mode === 'match' ? `${scopeNote} 중 매칭 중…`
      : extra.mode === 'brief' ? `브리프로 콘텐츠 ${body.count}편 생성 중${web}`
      : `${scopeNote} 기준 · 주제 ${body.count}개 × ${body.perTopic || 1} = 콘텐츠 ${total}편${web}`;
    if (auto) autoBanner(banner, note);
    else showJobBanner(banner, '콘텐츠 생성 요청 처리해줘', note);
    pollContent(jobId, banner, auto, stampCat);
  } catch (e) { banner.innerHTML = '오류: ' + esc(e.message); }
}
$('#genContent').onclick = () => submitGeneration({ mode: 'generate', topic: $('#cTopic').value.trim(), count: $('#cCount').value, perTopic: $('#cPerTopic').value, forms: [...selForms], persona: $('#cPersona').value.trim(), model: $('#cModel').value });

// 본문 형 다중선택(칩)
const FORMS = ['①후기·고백형', '②장면·몰입형', '③반전·통념깨기형', '④팁·정보형', '⑤단정·선언형', '⑥조건·타깃지목형', '⑦질문·대화형', '⑧비교·대조형', '⑨숫자·근거형', '⑩큐레이터편지형'];
const selForms = new Set();
function renderFormChips() {
  $('#formChips').innerHTML = FORMS.map((f) => `<span class="chip ${selForms.has(f) ? 'sel' : ''}" data-form="${esc(f)}">${esc(f)}</span>`).join('');
}
$('#formChips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (!c) return; const f = c.dataset.form; if (selForms.has(f)) selForms.delete(f); else selForms.add(f); c.classList.toggle('sel'); });

// 상품 타입 다중선택(프리미엄 호텔·리조트·라이프스타일·해외패키지·해외호텔·현지투어 등)
const selTypes = new Set();
let allProductTypes = []; // 전체 타입(출처 포함) — 구분 선택에 따라 필터
let typeCounts = null; // 현재 필터(지역+판매조건+날짜)의 타입별 상품 수. null=미로딩(전역 count 표시, 비활성 안 함)
let typeTotal = null;  // 현재 필터 풀의 총 상품 수(전체 0이면 생성 불가)
async function loadProductTypes() {
  try { const { types } = await api('/api/product-types'); allProductTypes = types || []; renderTypeChips(); } catch {}
}
// 지역/판매조건/날짜에 맞는 타입별 상품 수를 서버에서 받아 칩 count·활성화·생성가능 여부 갱신
async function refreshTypeCounts() {
  const scope = ($('#cScope') && $('#cScope').value) || 'domestic';
  const region = ($('#cRegion') && $('#cRegion').value) || '';
  const condition = ($('#cCondition') && $('#cCondition').value) || 'selling';
  const until = ($('#cUntil') && $('#cUntil').value) || '';
  const qs = `scope=${encodeURIComponent(scope)}&region=${encodeURIComponent(region)}&condition=${encodeURIComponent(condition)}&until=${encodeURIComponent(until)}`;
  try { const r = await api('/api/content/type-counts?' + qs); typeCounts = r.counts || {}; typeTotal = r.total || 0; }
  catch { typeCounts = null; typeTotal = null; }
  renderTypeChips(); updateGenGate();
}
// 선택한 구분(국내/해외)에 해당하는 타입만 노출(both는 항상). 구분 밖 선택은 해제. 0개 타입은 비활성(선택 불가).
function renderTypeChips() {
  const scope = ($('#cScope') && $('#cScope').value) || 'domestic';
  const shown = allProductTypes.filter((t) => t.source === scope || t.source === 'both');
  const shownSet = new Set(shown.map((t) => t.type));
  [...selTypes].forEach((t) => { if (!shownSet.has(t)) selTypes.delete(t); }); // 다른 구분 타입은 선택 해제
  const loaded = typeCounts !== null;
  shown.forEach((t) => { const c = loaded ? (typeCounts[t.type] || 0) : t.count; if (loaded && c === 0) selTypes.delete(t.type); }); // 0개면 선택 해제
  $('#typeChips').innerHTML = shown.map((t) => {
    const c = loaded ? (typeCounts[t.type] || 0) : t.count;
    const dis = loaded && c === 0;
    return `<span class="chip ${selTypes.has(t.type) ? 'sel' : ''}${dis ? ' disabled' : ''}" data-type="${esc(t.type)}"${dis ? ' aria-disabled="true"' : ''}>${esc(t.type)} <span class="muted">${c}</span></span>`;
  }).join('') || '<span class="muted sm">타입 정보 없음 (재크롤 후 표시)</span>';
}
// 전체 상품이 0개(직접 선택도 없음)면 콘텐츠 생성 버튼들을 비활성화 + 안내
function updateGenGate() {
  const empty = (typeTotal === 0) && !pickCodes.size && !regionModeOn(); // 조건에 맞는 상품이 하나도 없음(지역모드는 상품 불필요)
  ['#genContent', '#matchContent', '#genBrief'].forEach((id) => { const b = $(id); if (b) b.disabled = empty; });
  const note = $('#genEmptyNote'); if (note) note.classList.toggle('hidden', !empty);
}
$('#typeChips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (!c || c.classList.contains('disabled')) return; const t = c.dataset.type; if (selTypes.has(t)) selTypes.delete(t); else selTypes.add(t); c.classList.toggle('sel'); });
$('#matchContent').onclick = () => { if (!$('#mBody').value.trim()) return alert('매칭할 콘텐츠 본문을 입력하세요.'); submitGeneration({ mode: 'match', userTitle: $('#mTitle').value.trim(), userBody: $('#mBody').value.trim() }); };
$('#genBrief').onclick = () => { const brief = $('#bBrief').value.trim(); if (!brief) return alert('브리프(지시)를 입력하세요.'); submitGeneration({ mode: 'brief', brief, count: $('#bCount').value }); };

$('#togglePicker').onclick = async () => { const el = $('#pickerPanel'); const show = el.classList.contains('hidden'); el.classList.toggle('hidden'); if (show && !pickerRows.length) await loadPicker(); };
$('#pkClear').onclick = () => { pickCodes.clear(); $('#pickCount').textContent = 0; renderPicker(); updateGenGate(); };
['#pkSource', '#pkHotel', '#pkType', '#pkKeyword'].forEach((s) => $(s).addEventListener('input', () => { if (s === '#pkSource' || s === '#pkType' || s === '#pkHotel') fillPickHotels(); renderPicker(); }));
async function loadPicker() {
  try { const { rows } = await api('/api/products/pick'); pickerRows = rows; fillPickTypes(); fillPickHotels(); renderPicker(); }
  catch (e) { $('#pickerList').innerHTML = '오류: ' + esc(e.message); }
}
function fillPickTypes() {
  const types = [...new Set(pickerRows.map((r) => r.type).filter(Boolean))].sort();
  $('#pkType').innerHTML = '<option value="">종류 전체</option>' + types.map((t) => `<option>${esc(t)}</option>`).join('');
}
function fillPickHotels() {
  const src = $('#pkSource').value, type = $('#pkType').value;
  const names = [...new Set(pickerRows.filter((r) => (!src || r.source === src) && (!type || r.type === type)).map((r) => r.hotel || r.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
  // 검색형 입력: 입력한 키워드에 맞는 호텔·여행지만 datalist 후보로 노출(입력값이 있으면 부분일치 필터)
  const q = ($('#pkHotel').value || '').trim().toLowerCase();
  const cands = q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
  $('#pkHotelList').innerHTML = cands.slice(0, 300).map((n) => `<option value="${esc(n)}"></option>`).join('');
}
function pickFiltered() {
  const src = $('#pkSource').value, hotel = $('#pkHotel').value.trim(), type = $('#pkType').value, kw = $('#pkKeyword').value.trim();
  return pickerRows.filter((r) => {
    if (src && r.source !== src) return false;
    if (hotel && !(`${r.hotel || ''} ${r.region || ''}`).toLowerCase().includes(hotel.toLowerCase())) return false; // 부분일치
    if (type && r.type !== type) return false;
    if (kw && !(`${r.hotel} ${r.region} ${r.name}`).includes(kw)) return false;
    return true;
  });
}
function renderPicker() {
  const rows = pickFiltered();
  const meta = () => $('#pkMeta').textContent = `${rows.length.toLocaleString()}개 표시 · 선택 ${pickCodes.size}개`;
  meta();
  $('#pickerList').innerHTML = rows.slice(0, 500).map((r) => { const code = r.productCode || r.productId; return `<div class="pick-row ${pickCodes.has(code) ? 'sel' : ''}">
    <label class="pick-check"><input type="checkbox" data-code="${esc(code)}" ${pickCodes.has(code) ? 'checked' : ''} /></label>
    <div class="pick-main"><div class="pick-name">${esc(r.name)}</div>
    <div class="pick-sub">${esc(r.hotel || r.region)} · ${esc(r.type)} · ${won(r.price)}${r.status && r.status !== '판매중' ? ' · ' + esc(r.status) : ''}</div></div></div>`; }).join('') || '<div class="muted">조건에 맞는 상품이 없어요.</div>';
  $$('#pickerList input[type=checkbox]').forEach((cb) => cb.onchange = () => {
    const c = cb.dataset.code; if (cb.checked) pickCodes.add(c); else pickCodes.delete(c);
    cb.closest('.pick-row').classList.toggle('sel', cb.checked); $('#pickCount').textContent = pickCodes.size; meta(); updateGenGate();
  });
}
function autoBanner(el, note) {
  el.innerHTML = `<div><span class="spinner"></span> <b>Claude가 자동으로 작업 중…</b> ${esc(note || '')}</div>
    <div class="muted sm" style="margin-top:6px">별도 세션에서 처리 중이라 문구 입력은 필요 없어요. 잠시만 기다려 주세요.</div>`;
}
function showJobBanner(el, phrase, note) {
  el.innerHTML = `<div><span class="spinner"></span> <b>Claude가 작업 중…</b> ${esc(note || '')}</div>
    <div class="trigger">지금 이 채팅(Claude Code)에 입력 → <code>${esc(phrase)}</code>
    <button class="btn sm" onclick="navigator.clipboard.writeText('${esc(phrase)}')">복사</button></div>`;
}
function usageLine(u) {
  if (!u) return '생성 완료.';
  const inTok = (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheCreateTokens || 0);
  return `생성 완료 · 모델 ${esc(u.model || '')} · 토큰 입력 ${inTok.toLocaleString()} / 출력 ${(u.outputTokens || 0).toLocaleString()} · 비용 $${(u.costUsd || 0).toFixed(4)} · ${Math.round((u.durationMs || 0) / 1000)}초`;
}
function pollContent(jobId, banner, auto, stampCat) {
  let tries = 0;
  const t = setInterval(async () => {
    tries++;
    try {
      const s = await api('/api/content/job?id=' + jobId);
      if (s.status === 'done' && s.items) {
        if (stampCat) s.items.forEach((it) => { it.category = stampCat; }); // 생성 scope로 국내/해외 분류 기록
        clearInterval(t); renderContentCards(s.items); markDone(2);
        banner.classList.remove('hidden'); banner.innerHTML = usageLine(s.usage);
        if (!s.usage) setTimeout(async () => { try { const s2 = await api('/api/content/job?id=' + jobId); banner.innerHTML = usageLine(s2.usage); } catch {} }, 3000);
        return;
      }
      if (auto && tries === 60) showJobBanner(banner, '콘텐츠 생성 요청 처리해줘', '자동 처리가 지연되네요. 이 문구를 입력하면 수동으로 처리돼요.');
    } catch (e) { clearInterval(t); banner.innerHTML = '오류: ' + esc(e.message); }
  }, 1500);
}
function cardInner(it) {
  const hotels = it.hotels && it.hotels.length ? it.hotels : [...new Set((it.matched || []).map((m) => m.hotel).filter(Boolean))];
  const hotelChips = hotels.map((h) => `<span class="badge">${esc(h)}</span>`).join('');
  const matched = (it.matched || []).map((m) => `<li>${esc(m.hotel)} — ${esc(m.productName)} <code>${esc(m.productId || m.productCode || '-')}</code> ${m.status && m.status !== '판매중' ? '(' + esc(m.status) + ')' : ''}</li>`).join('');
  const alts = (it.titleAlternatives && it.titleAlternatives.length)
    ? `<div class="alts"><b>제목 후보</b><ul>${it.titleAlternatives.map((a) => `<li>${esc(a.title || a)}${a.reason ? ` <span class="muted">— ${esc(a.reason)}</span>` : ''}</li>`).join('')}</ul></div>` : '';
  return `<h3>${esc(it.title)}</h3>
    <div class="meta">${it.form ? `<span class="badge">${esc(it.form)}</span>` : ''}${it.persona ? `<span class="badge">${esc(it.persona)}</span>` : ''}</div>
    <div class="body">${specHtml(it.body, it.speculative)}</div>
    ${(it.speculative && it.speculative.length) ? '<div class="spec-note">색이 다른 문장 = 추측성(데이터·검색으로 미확인). 발행 전 확인하세요.</div>' : ''}
    ${alts}
    <div class="hotels"><b>매칭 호텔/여행지 (${hotels.length})</b><div class="meta">${hotelChips}</div></div>
    <div class="matched"><b>매칭 상품 ${it.matched ? '(' + it.matched.length + '개)' : ''}</b><ul>${matched}</ul></div>`;
}
function renderContentCards(items) {
  $('#contentCards').innerHTML = items.map((it, i) => `<div class="ccard" data-i="${i}">${cardInner(it)}
    <div class="card-actions"><button class="btn primary pick">이 콘텐츠 선택<br>→ 상품/쇼룸 선택</button><button class="btn edit">수정</button><button class="btn save">저장</button><button class="btn ref">모범</button></div></div>`).join('');
  $$('#contentCards .pick').forEach((btn, i) => btn.onclick = () => selectContent(items[i]));
  $$('#contentCards .save').forEach((btn, i) => btn.onclick = () => toggleSave(items[i], btn));
  $$('#contentCards .ref').forEach((btn, i) => btn.onclick = () => toggleRef(items[i], btn));
  $$('#contentCards .edit').forEach((btn, i) => btn.onclick = () => editContentCard(btn.closest('.ccard'), items[i], (edited) => { if (edited) items[i] = edited; renderContentCards(items); }));
}
// 카드 텍스트(제목·본문·형·화자) 인라인 수정
function editContentCard(cardEl, item, onDone) {
  cardEl.innerHTML = `
    <label class="block">제목<input class="input ed-title" value="${esc(item.title || '')}" /></label>
    <label class="block">본문<textarea class="input ed-body" rows="5">${esc(item.body || '')}</textarea></label>
    <div class="form">
      <label>본문 형<input class="input ed-form" value="${esc(item.form || '')}" /></label>
      <label class="grow">화자<input class="input ed-persona" value="${esc(item.persona || '')}" /></label>
    </div>
    <div class="card-actions"><button class="btn primary ed-apply">적용</button><button class="btn ed-cancel">취소</button></div>`;
  cardEl.querySelector('.ed-apply').onclick = () => onDone({ ...item, title: cardEl.querySelector('.ed-title').value.trim(), body: cardEl.querySelector('.ed-body').value.trim(), form: cardEl.querySelector('.ed-form').value.trim(), persona: cardEl.querySelector('.ed-persona').value.trim() });
  cardEl.querySelector('.ed-cancel').onclick = () => onDone(null);
}
// 저장 토글 — 한 번 더 누르면 저장 취소
async function toggleSave(item, btn) {
  try {
    if (btn && btn.dataset.savedId) {
      await api('/api/saved?id=' + encodeURIComponent(btn.dataset.savedId), { method: 'DELETE' });
      delete btn.dataset.savedId; btn.classList.remove('on'); btn.textContent = '저장';
    } else {
      const r = await api('/api/saved', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item }) });
      if (btn) { btn.dataset.savedId = r.id; btn.classList.add('on'); btn.textContent = '저장됨 ✓'; }
    }
    refreshSaved();
  } catch (e) { alert('저장 실패: ' + e.message); }
}
// 모범 토글 — 한 번 더 누르면 모범 등록 취소
async function toggleRef(item, btn) {
  try {
    if (btn && btn.dataset.refId) {
      await api('/api/references?id=' + encodeURIComponent(btn.dataset.refId), { method: 'DELETE' });
      delete btn.dataset.refId; btn.classList.remove('on'); btn.textContent = '모범';
    } else {
      const r = await api('/api/references', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item }) });
      if (btn) { btn.dataset.refId = r.id; btn.classList.add('on'); btn.textContent = '모범 ✓'; }
    }
    loadReferences();
  } catch (e) { alert('모범 등록 실패: ' + e.message); }
}
async function refreshSaved() {
  try {
    const { items } = await api('/api/saved');
    $('#savedCount').textContent = items.length;
    if (!$('#savedList').classList.contains('hidden')) renderSaved(items);
  } catch {}
}
// ── 모범 콘텐츠(참고 예시 · few-shot 학습) ────────────────────────────────────
let me = { isCurator: true, curationEnabled: false, shared: false, user: '' };
async function loadMe() {
  try { me = await api('/api/me'); } catch {}
  document.body.classList.toggle('non-curator', !!me.curationEnabled && !me.isCurator);
  const info = $('#refCurInfo');
  if (info) info.textContent = me.curationEnabled
    ? `담당자 전용 · 나(${me.user}) = ${me.isCurator ? '등록 가능 ' : '읽기 전용(등록 불가)'} · 담당자 ${me.curators.length}명`
    : (me.shared ? '공유 저장소(자유 등록)' : '로컬(개인 저장)');
}
$('#syncRef').onclick = async () => { $('#syncRef').textContent = '동기화 중…'; try { const r = await api('/api/references/sync', { method: 'POST' }); renderReferences(r.items); $('#refCount').textContent = r.items.length; } catch {} $('#syncRef').textContent = '최신 모범 받기'; };
$('#toggleRef').onclick = async () => { const el = $('#refPanel'); const show = el.classList.contains('hidden'); el.classList.toggle('hidden'); $('#toggleRef').classList.toggle('on', show); if (show) { loadMe(); loadReferences(); } };
$('#addRef').onclick = async () => {
  const body = $('#refBody').value.trim();
  if (!body) return alert('본문을 입력하세요.');
  await addReference({ title: $('#refTitle').value.trim(), body, form: $('#refForm').value.trim() });
  $('#refTitle').value = ''; $('#refBody').value = ''; $('#refForm').value = '';
};
async function addReference(item) {
  try { await api('/api/references', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item }) }); loadReferences(); }
  catch (e) { alert('모범 등록 실패: ' + e.message); }
}
async function loadReferences() {
  try { const { items } = await api('/api/references'); $('#refCount').textContent = items.length; if (!$('#refPanel').classList.contains('hidden')) renderReferences(items); } catch {}
}
function renderReferences(items) {
  const el = $('#refList');
  $('#refCount').textContent = items.length;
  if (!items.length) { el.innerHTML = '<div class="muted">등록된 모범 콘텐츠가 없어요. 위에 붙여넣거나, 생성된/저장된 카드의 [모범]으로 담아보세요.</div>'; return; }
  // 본문 형별로 그룹핑해 모아보기
  const byForm = {};
  items.forEach((it) => { const k = it.form || '(형 미지정)'; (byForm[k] = byForm[k] || []).push(it); });
  el.innerHTML = `<div class="muted sm" style="margin:6px 0 10px">총 ${items.length}편 · 형 ${Object.keys(byForm).length}종</div>` +
    Object.entries(byForm).map(([form, list]) => `<div class="ref-group"><div class="ref-group-h">${esc(form)} <span class="muted">${list.length}</span></div>
      <div class="ref-grid">${list.map((it) => `<div class="ref-card" data-id="${esc(it.id)}">
        <div class="ref-head"><b>${esc(it.title || '(제목 없음)')}</b></div>
        <div class="ref-body">${esc(it.body || '')}</div>
        <div class="row between ref-foot"><span class="muted sm">${it.addedBy ? esc(it.addedBy) + ' · ' : ''}${it.addedAt ? new Date(it.addedAt).toLocaleDateString('ko-KR') : ''}</span><button class="btn sm ref-del">삭제</button></div>
      </div>`).join('')}</div></div>`).join('');
  $$('#refList .ref-del').forEach((b) => b.onclick = async () => { await api('/api/references?id=' + encodeURIComponent(b.closest('.ref-card').dataset.id), { method: 'DELETE' }); loadReferences(); });
}

// ── 예약 생성(스케줄) ─────────────────────────────────────────────────────────
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
function currentGenParams() {
  return { ...commonBody(), mode: 'generate', topic: $('#cTopic').value.trim(), count: $('#cCount').value, perTopic: $('#cPerTopic').value, forms: [...selForms], persona: $('#cPersona').value.trim(), model: $('#cModel').value };
}
$('#schType').addEventListener('change', () => {
  const t = $('#schType').value;
  $('#schDayWrap').classList.toggle('hidden', t !== 'weekly');
  $('#schDateWrap').classList.toggle('hidden', t !== 'once');
});
$('#toggleSchedule').onclick = async () => { const el = $('#schedulePanel'); const show = el.classList.contains('hidden'); el.classList.toggle('hidden'); $('#toggleSchedule').classList.toggle('on', show); if (show) loadSchedules(); };
$('#addSchedule').onclick = async () => {
  const body = { name: $('#schName').value.trim() || '예약 생성', cronType: $('#schType').value, dayOfWeek: $('#schDay').value, date: $('#schDate').value, time: $('#schTime').value, params: currentGenParams() };
  if (!body.time) return alert('시간을 정하세요.');
  if (body.cronType === 'once' && !body.date) return alert('한 번만 실행은 날짜를 정하세요.');
  try { await api('/api/schedules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); $('#schName').value = ''; loadSchedules(); }
  catch (e) { alert('예약 추가 실패: ' + e.message); }
};
async function loadSchedules() {
  try {
    const { schedules } = await api('/api/schedules');
    $('#scheduleCount').textContent = schedules.length;
    renderSchedules(schedules);
  } catch {}
}
function schWhen(s) {
  if (s.cronType === 'daily') return `매일 ${s.time}`;
  if (s.cronType === 'weekly') return `매주 ${DOW[Number(s.dayOfWeek)]} ${s.time}`;
  return `${s.date} ${s.time} (한 번)`;
}
function renderSchedules(schedules) {
  const el = $('#scheduleList');
  if (!schedules.length) { el.innerHTML = '<div class="muted">등록된 예약이 없어요.</div>'; return; }
  el.innerHTML = schedules.map((s) => {
    const p = s.params || {};
    const summary = `${p.scope === 'overseas' ? '해외' : '국내'} · 주제 ${p.count || 1}×${p.perTopic || 1}${(p.forms && p.forms.length) ? ' · 형 ' + p.forms.length : ''}${p.productCodes && p.productCodes.length ? ' · 선택상품 ' + p.productCodes.length : ''}`;
    return `<div class="pick-row ${s.enabled ? 'sel' : ''}" data-id="${esc(s.id)}">
      <label class="pick-check"><input type="checkbox" class="sch-toggle" ${s.enabled ? 'checked' : ''} /></label>
      <div class="pick-main"><div class="pick-name">${esc(s.name)} · <span class="badge">${esc(schWhen(s))}</span></div>
      <div class="pick-sub">${esc(summary)}${s.lastRunAt ? ' · 최근실행 ' + new Date(s.lastRunAt).toLocaleString('ko-KR') : ''}</div></div>
      <button class="btn sm sch-run">지금 실행</button>
      <button class="btn sm sch-del">삭제</button>
    </div>`;
  }).join('');
  $$('#scheduleList .pick-row').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('.sch-toggle').onchange = async (e) => { await api('/api/schedules/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, enabled: e.target.checked }) }); loadSchedules(); };
    row.querySelector('.sch-del').onclick = async () => { await api('/api/schedules?id=' + encodeURIComponent(id), { method: 'DELETE' }); loadSchedules(); };
    row.querySelector('.sch-run').onclick = async () => { try { const r = await api('/api/schedules/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }); alert(`지금 실행: 상품 ${r.productCount}개 기준으로 생성 시작(완료되면 저장된 콘텐츠에 추가돼요).`); } catch (e) { alert('실행 실패: ' + e.message); } };
  });
}

let savedAll = [];        // 저장 콘텐츠 전체(원본)
let savedFilter = 'all';  // 'all' | 'domestic' | 'overseas' | 'unknown'
const CAT_LABEL = { domestic: '국내 호텔', overseas: '해외 여행상품', unknown: '· 미분류' };
$('#toggleSaved').onclick = async () => {
  const el = $('#savedList'); const show = el.classList.contains('hidden');
  el.classList.toggle('hidden');
  $('#savedFilter').classList.toggle('hidden', !show);
  $('#toggleSaved').classList.toggle('on', show); // 열려 있으면 색 반전
  if (show) { const { items } = await api('/api/saved'); savedAll = items; renderSavedFilter(); renderSaved(currentSaved()); }
};
function currentSaved() { return savedFilter === 'all' ? savedAll : savedAll.filter((it) => (it.category || 'unknown') === savedFilter); }
function renderSavedFilter() {
  const el = $('#savedFilter');
  const counts = { all: savedAll.length, domestic: 0, overseas: 0, unknown: 0 };
  savedAll.forEach((it) => { counts[it.category || 'unknown'] = (counts[it.category || 'unknown'] || 0) + 1; });
  const tabs = [['all', '전체']].concat(
    counts.domestic ? [['domestic', CAT_LABEL.domestic]] : [],
    counts.overseas ? [['overseas', CAT_LABEL.overseas]] : [],
    counts.unknown ? [['unknown', CAT_LABEL.unknown]] : []);
  el.innerHTML = tabs.map(([k, label]) => `<button class="chip${savedFilter === k ? ' sel' : ''}" data-cat="${k}">${label} (${counts[k] || 0})</button>`).join('');
  $$('#savedFilter .chip').forEach((b) => b.onclick = () => { savedFilter = b.dataset.cat; renderSavedFilter(); renderSaved(currentSaved()); });
}

// 저장 콘텐츠 학습 분석 — 저장 콘텐츠의 특징을 분석해 다음 생성 품질에 반영(마크다운도 갱신)
$('#analyzeSaved').onclick = async () => {
  const banner = $('#analyzeBanner');
  banner.classList.remove('hidden');
  banner.innerHTML = '<span class="spinner"></span> 저장 콘텐츠를 분석하는 중… (Claude가 특징을 뽑아 학습 자산으로 정리합니다)';
  try {
    const { id, count } = await api('/api/saved/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: ($('#cModel') && $('#cModel').value) || 'opus' }) });
    banner.innerHTML = `<span class="spinner"></span> 저장 콘텐츠 ${count}편 분석 중…`;
    let tries = 0;
    const poll = setInterval(async () => {
      tries++;
      let j; try { j = await api('/api/saved/analyze/' + encodeURIComponent(id)); } catch { return; }
      if (j.status === 'done') {
        clearInterval(poll);
        renderAnalyzeResult(banner, j);
      } else if (tries > 180) { clearInterval(poll); banner.innerHTML = '분석이 지연되고 있어요. 잠시 후 다시 시도해 주세요.'; }
    }, 2000);
  } catch (e) { banner.innerHTML = '분석 실패: ' + esc(e.message); }
};
function renderAnalyzeResult(banner, j) {
  const ins = j.insights || {};
  const principles = (ins.principles || []).map((p) => `<li>${esc(p)}</li>`).join('');
  const titles = (ins.titlePatterns || []).map((p) => `<li>${esc(p)}</li>`).join('');
  const avoid = (ins.avoid || []).map((p) => `<li>${esc(p)}</li>`).join('');
  banner.innerHTML = `<div class="analyze-result">
    <div class="row between"><b>저장 콘텐츠 학습 분석 완료 (${ins.count || 0}편)</b><button class="btn sm" id="analyzeClose">닫기</button></div>
    ${ins.summary ? `<p class="muted sm">${esc(ins.summary)}</p>` : ''}
    ${principles ? `<div><b class="sm">적용 원칙</b><ul class="sm">${principles}</ul></div>` : ''}
    ${titles ? `<div><b class="sm">제목 패턴</b><ul class="sm">${titles}</ul></div>` : ''}
    ${ins.toneNotes ? `<div><b class="sm">톤·보이스</b><p class="muted sm">${esc(ins.toneNotes)}</p></div>` : ''}
    ${avoid ? `<div><b class="sm">피할 것</b><ul class="sm">${avoid}</ul></div>` : ''}
    <p class="muted sm">이 원칙은 앞으로 콘텐츠 생성 시 자동으로 반영됩니다. (마크다운: <code>저장콘텐츠_학습분석.md</code> 갱신됨)</p>
  </div>`;
  const close = $('#analyzeClose'); if (close) close.onclick = () => banner.classList.add('hidden');
}
async function reloadSaved() {
  const { items } = await api('/api/saved'); savedAll = items;
  $('#savedCount').textContent = items.length; renderSavedFilter(); renderSaved(currentSaved());
}
function renderSaved(items) {
  const el = $('#savedList');
  if (!items.length) { el.innerHTML = `<div class="muted">${savedFilter === 'all' ? '저장된 콘텐츠가 없어요. 카드의 저장을 눌러 담아두세요.' : '이 분류에 저장된 콘텐츠가 없어요.'}</div>`; return; }
  const bulk = (savedFilter === 'unknown' && items.length)
    ? `<div class="bulk-recat"><span class="sm">미분류 ${items.length}편을 한 번에:</span><button class="btn sm" id="bulkDom">모두 국내 호텔로</button><button class="btn sm" id="bulkOvs">모두 해외 여행상품으로</button></div>` : '';
  el.innerHTML = bulk + items.map((it) => `<div class="ccard" data-id="${esc(it.id)}"><div class="cat-badge cat-${it.category || 'unknown'}">${CAT_LABEL[it.category] || CAT_LABEL.unknown}</div>${cardInner(it)}
    ${(it.category || 'unknown') === 'unknown' ? `<div class="recat"><span class="muted sm">분류 지정:</span><button class="btn sm recat-dom">국내 호텔</button><button class="btn sm recat-ovs">해외 여행상품</button></div>` : ''}
    <div class="card-actions"><button class="btn primary pick">이 콘텐츠 선택<br>→ 상품/쇼룸 선택</button><button class="btn edit">수정</button><button class="btn ref">모범</button><button class="btn remove">삭제</button></div>
    <div class="muted sm" style="margin-top:6px">저장 ${new Date(it.savedAt).toLocaleString('ko-KR')}${it.fromSchedule ? ' · 예약 실행' : ''}</div></div>`).join('');
  $$('#savedList .pick').forEach((btn, i) => btn.onclick = () => selectContent(items[i]));
  $$('#savedList .ref').forEach((btn, i) => btn.onclick = () => toggleRef(items[i], btn));
  const setCat = async (id, category) => { await api('/api/saved/categorize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, category }) }); reloadSaved(); };
  $$('#savedList .recat-dom').forEach((btn, i) => btn.onclick = () => setCat(items[i].id, 'domestic'));
  $$('#savedList .recat-ovs').forEach((btn, i) => btn.onclick = () => setCat(items[i].id, 'overseas'));
  const bulkSet = async (category) => {
    for (const it of items) { try { await api('/api/saved/categorize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: it.id, category }) }); } catch {} }
    reloadSaved();
  };
  if ($('#bulkDom')) $('#bulkDom').onclick = () => bulkSet('domestic');
  if ($('#bulkOvs')) $('#bulkOvs').onclick = () => bulkSet('overseas');
  $$('#savedList .remove').forEach((btn, i) => btn.onclick = async () => {
    await api('/api/saved?id=' + encodeURIComponent(items[i].id), { method: 'DELETE' });
    reloadSaved();
  });
  $$('#savedList .edit').forEach((btn, i) => btn.onclick = () => editContentCard(btn.closest('.ccard'), items[i], async (edited) => {
    if (!edited) return renderSaved(items);
    await api('/api/saved?id=' + encodeURIComponent(items[i].id), { method: 'DELETE' }); // 제목/본문 바뀌면 id가 바뀌므로 기존 것 제거 후 재저장
    await api('/api/saved', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item: edited }) });
    reloadSaved();
  }));
}
async function selectContent(item) {
  selectedContent = item;
  await api('/api/content/select', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item }) });
  await setupProductStep();
  goStep(3);
}

// ── ③ 아이템 선택 (상품 / 쇼룸) ──────────────────────────────────────────────
async function setupProductStep() {
  selectedProducts.clear(); selectedShowrooms.clear();
  exposureType = 'goods';
  const g = document.querySelector('input[name="expoType"][value="goods"]'); if (g) g.checked = true;
  renderProductPick();
  await loadShowroomCandidates(); renderShowroomPick();
  setExposure('goods');
}
function updateProdHint() {
  const c = selectedContent || {};
  if (exposureType === 'showroom') $('#prodStepHint').textContent = `콘텐츠 「${c.title || ''}」 · 추천 쇼룸 중 노출할 쇼룸을 선택 (미선택 시 전체)`;
  else $('#prodStepHint').textContent = `콘텐츠 「${c.title || ''}」 · 추천 상품 ${(c.matched || []).length}개 중 넣을 상품을 선택 (미선택 시 전체)`;
}
function setExposure(t) {
  exposureType = t;
  $('#productPick').classList.toggle('hidden', t !== 'goods');
  $('#showroomPick').classList.toggle('hidden', t !== 'showroom');
  updateProdHint();
}
$$('input[name="expoType"]').forEach((r) => r.onchange = () => setExposure(r.value));
// 추천 쇼룸: 서버가 크롤 데이터와 대조해 도출한 "정확 명칭"(국내=호텔명, 해외=지역명)을 사용
let showroomCands = [];
async function loadShowroomCandidates() {
  try { const { candidates } = await api('/api/content/showrooms'); showroomCands = candidates || []; }
  catch { showroomCands = []; }
}
function showroomCandidates() { return showroomCands; }
function renderShowroomPick() {
  const cands = showroomCandidates();
  $('#showroomPick').innerHTML = cands.map((s, i) => `
    <div class="pick-row ${selectedShowrooms.has(s.name) ? 'sel' : ''}">
      <label class="pick-check"><input type="checkbox" ${selectedShowrooms.has(s.name) ? 'checked' : ''} data-i="${i}" /></label>
      <div class="pick-main">
        <div class="pick-name">${esc(s.name)} ${s.exact === false ? '<span class="badge warn" title="크롤 데이터에서 명칭을 못 찾았어요. 등록 전 확인 필요">확인필요</span>' : '<span class="badge ok" title="크롤에서 확정된 명칭 · 등록 시 백오피스 쇼룸과 최종 매칭(명칭이 다르면 선택 요청)">크롤명 확정</span>'}</div>
        <div class="pick-sub">${s.kind === 'region' ? '지역(해외)' : '호텔(국내)'} · 연결 상품 ${s.products.length}개</div>
      </div>
    </div>`).join('') || '<div class="muted">추천 쇼룸이 없습니다. (콘텐츠에 매칭 호텔/지역이 없어요)</div>';
  $$('#showroomPick input[type=checkbox]').forEach((cb) => cb.onchange = () => {
    const s = cands[+cb.dataset.i];
    if (cb.checked) selectedShowrooms.set(s.name, s); else selectedShowrooms.delete(s.name);
    cb.closest('.pick-row').classList.toggle('sel', cb.checked);
  });
}
function renderProductPick() {
  const matched = selectedContent.matched || [];
  $('#productPick').innerHTML = matched.map((m, i) => `
    <div class="pick-row ${selectedProducts.has(m.productId) ? 'sel' : ''}">
      <label class="pick-check"><input type="checkbox" ${selectedProducts.has(m.productId) ? 'checked' : ''} data-i="${i}" /></label>
      <div class="pick-main">
        <div class="pick-name">${esc(m.productName)}</div>
        <div class="pick-sub">${esc(m.hotel)} · 상품ID <code>${esc(m.productId || '-')}</code> · 코드 <code>${esc(m.productCode || '-')}</code> · ${won(m.price)}${m.status && m.status !== '판매중' ? ' · ' + esc(m.status) : ''}</div>
      </div>
      <button class="detail-btn" data-detail="${esc(m.productId)}">자세히</button>
    </div>`).join('') || '<div class="muted">추천 상품이 없습니다.</div>';
  $$('#productPick input[type=checkbox]').forEach((cb) => cb.onchange = () => {
    const m = matched[+cb.dataset.i];
    if (cb.checked) selectedProducts.set(m.productId, m); else selectedProducts.delete(m.productId);
    cb.closest('.pick-row').classList.toggle('sel', cb.checked);
  });
  $$('#productPick .detail-btn').forEach((b) => b.onclick = () => fetchAndShowProduct(b.dataset.detail));
}
async function fetchAndShowProduct(id) {
  try { const { product } = await api('/api/product?id=' + encodeURIComponent(id)); openProductModal(product); }
  catch (e) { alert('상품 정보를 불러오지 못했어요: ' + e.message); }
}
$('#prodSelectAll').onclick = () => {
  if (exposureType === 'showroom') {
    const cands = showroomCandidates();
    if (selectedShowrooms.size === cands.length) selectedShowrooms.clear();
    else cands.forEach((s) => selectedShowrooms.set(s.name, s));
    renderShowroomPick();
  } else {
    const matched = selectedContent.matched || [];
    if (selectedProducts.size === matched.length) selectedProducts.clear();
    else matched.forEach((m) => selectedProducts.set(m.productId, m));
    renderProductPick();
  }
};
$('#confirmProducts').onclick = async () => {
  if (exposureType === 'showroom') {
    const chosen = selectedShowrooms.size ? [...selectedShowrooms.values()] : showroomCandidates();
    if (!chosen.length) return alert('추천 쇼룸이 없습니다.');
    await api('/api/content/exposure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exposureType: 'showroom', showrooms: chosen }) });
  } else {
    const chosen = selectedProducts.size ? [...selectedProducts.values()] : (selectedContent.matched || []);
    await api('/api/content/exposure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exposureType: 'goods', products: chosen }) });
  }
  markDone(3);
  setupImageStep();
  goStep(4);
};

// ── ③ 이미지 찾기 ────────────────────────────────────────────────────────────
function setupImageStep() {
  selectedTiles.clear(); // 새 콘텐츠로 진입 시 선택 초기화(폴더 전환에는 유지)
  // 노출 종류에 맞춰 이미지 대상 구성(쇼룸 노출이면 쇼룸명, 대표 상품코드로 이미지 해석 재사용)
  const src = exposureType === 'showroom'
    ? (selectedShowrooms.size ? [...selectedShowrooms.values()] : showroomCandidates()).map((s) => ({ productName: s.name, name: s.name, hotel: s.kind === 'hotel' ? s.name : (s.hotel || s.name), region: s.kind === 'region' ? s.name : s.region, productCode: s.code, productId: s.code, price: '', isShowroom: true }))
    : (selectedProducts.size ? [...selectedProducts.values()] : (selectedContent.matched || []));
  const hotels = [...new Set(src.map((m) => m.hotel).filter(Boolean))];
  $('#imgHotelHint').textContent = selectedContent ? `선택 ${exposureType === 'showroom' ? '쇼룸' : '상품'} ${hotels.length}곳에서 이미지를 찾습니다.` : '';
  const body = selectedContent.body || '';
  $('#imgSide').innerHTML = `
    <div class="side-block">
      <div class="side-h">선택 콘텐츠</div>
      <div class="side-title">${esc(selectedContent.title)}</div>
      <div class="side-body">${specHtml(body, selectedContent.speculative)}</div>
    </div>
    <div class="side-block">
      <div class="side-h">선택 ${exposureType === 'showroom' ? '쇼룸' : '상품'} (${src.length})</div>
      <ul class="side-products">${src.map((m) => `<li><div class="sp-name">${esc(m.productName || m.name)}</div><div class="sp-sub">${esc(m.hotel)} · ${won(m.price)}${m.productId ? ' · ID ' + esc(m.productId) : ''}</div></li>`).join('')}</ul>
    </div>`;
  // 상품 유형에 맞게 해석하도록 타깃(대표 상품코드)별로 구성 — 호텔/여행지 단위 중복 제거
  const seen = new Set();
  imgTargets = [];
  src.forEach((m) => { const key = m.hotel || m.region || m.productName; if (seen.has(key)) return; seen.add(key); imgTargets.push({ label: key, code: m.productCode || m.productId || '', hotel: m.hotel || m.region || '' }); });
  const sel = $('#imgHotelSelect');
  sel.innerHTML = imgTargets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('') || '<option>매칭 대상 없음</option>';
  loadUploads();
  if (imgTargets.length) loadTarget(0); else renderGallery();
}
let imgTargets = [];
let currentTarget = null;
let uploadedImages = []; // 내가 업로드한 이미지(NAS 아님, path='upload:<id>')
$('#imgHotelSelect').addEventListener('change', (e) => loadTarget(+e.target.value));
$('#imgFilter').addEventListener('input', () => renderGallery());
async function loadUploads() { try { const { images } = await api('/api/uploads'); uploadedImages = images || []; renderGallery(); } catch {} }
$('#imgUpload').onchange = async (e) => {
  const files = [...e.target.files]; if (!files.length) return;
  const meta = $('#imgMeta'); meta.textContent = `업로드 중… (${files.length}장)`;
  const payload = [];
  for (const f of files) { const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); }); payload.push({ name: f.name, dataUrl }); }
  try {
    const { images } = await api('/api/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: payload }) });
    uploadedImages = [...images, ...uploadedImages];
    meta.textContent = `업로드 ${images.length}장 추가됨`;
    renderGallery();
  } catch (err) { meta.textContent = '업로드 실패: ' + err.message; }
  e.target.value = '';
};
function loadTarget(i) { currentTarget = imgTargets[i]; if (currentTarget) loadImages(currentTarget); }
async function loadImages(target) {
  const meta = $('#imgMeta'); meta.textContent = '불러오는 중…'; recPicks = null; // 선택 이미지는 폴더 전환에도 유지
  const hotel = target.hotel || target;
  try {
    const qs = target.code ? `productCode=${encodeURIComponent(target.code)}&hotel=${encodeURIComponent(hotel)}` : `hotel=${encodeURIComponent(hotel)}`;
    const d = await api('/api/images?' + qs);
    galleryImages = (d.images || []).map((im) => ({ ...im, hotel }));
    const modeTag = d.mode === 'overseas' ? '해외' : d.mode === 'overseas-country' ? '해외(나라전체)' : d.mode === 'overseas-hotel' ? '해외호텔' : '';
    const where = d.imageDir ? d.imageDir.split('/').slice(-2).join('/') : '매칭 실패 — 직접 선택 필요';
    meta.textContent = `${d.count || 0}장 · ${modeTag ? '[' + modeTag + '] ' : ''}폴더: ${where}`;
    renderGallery();
  } catch (e) { meta.textContent = '오류: ' + e.message; $('#gallery').innerHTML = `<div class="muted">이미지를 찾지 못했습니다: ${esc(e.message)}</div>`; }
}
function renderGallery() {
  const kw = $('#imgFilter').value.trim();
  const combined = [...uploadedImages, ...galleryImages]; // 업로드 이미지를 앞에
  const imgs = kw ? combined.filter((im) => ((im.folder || '') + ' ' + (im.name || '')).includes(kw)) : combined;
  const pickByPath = new Map((recPicks || []).map((pk) => [pk.nasPath, pk]));
  $('#gallery').innerHTML = imgs.map((im) => {
    const src = `/api/thumb?path=${encodeURIComponent(im.path)}&size=small&mtime=${encodeURIComponent(im.mtime || '')}`;
    const rec = pickByPath.get(im.path);
    return `<div class="tile ${selectedTiles.has(im.path) ? 'sel' : ''} ${rec ? 'rec' : ''}" data-path="${esc(im.path)}" title="${esc(rec ? rec.reason : im.folder || '')}">
      <img loading="lazy" src="${src}" alt="" />
      ${rec ? `<span class="rank">${rec.rank || ''}</span>` : ''}
      <span class="check">✓</span>
      ${im.folder ? `<span class="cat">${esc(im.folder)}</span>` : ''}
    </div>`;
  }).join('') || '<div class="muted">이미지가 없습니다.</div>';
  $$('#gallery .tile').forEach((t) => {
    t.onclick = () => { const path = t.dataset.path; if (selectedTiles.has(path)) selectedTiles.delete(path); else selectedTiles.set(path, allImages().find((im) => im.path === path)); t.classList.toggle('sel'); renderSelectedStrip(); };
    t.querySelector('img').ondblclick = (e) => { e.stopPropagation(); openLightbox(t.dataset.path); };
  });
  renderSelectedStrip();
}
function allImages() { return [...uploadedImages, ...galleryImages]; }
// 선택한 이미지 모아보기(폴더/호텔 전환에도 유지 — 유저가 전체 선택 현황 확인)
function renderSelectedStrip() {
  const el = $('#selectedStrip'); if (!el) return;
  const items = [...selectedTiles.values()].filter(Boolean);
  if (!items.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = `<div class="sel-head"><b>선택한 이미지 (${items.length})</b><button class="btn xs" id="selClear">전체 해제</button></div>
    <div class="sel-thumbs">${items.map((im) => `<div class="sel-thumb" data-path="${esc(im.path)}" title="${esc((im.hotel || '') + ' · ' + (im.folder || ''))}">
      <img loading="lazy" src="/api/thumb?path=${encodeURIComponent(im.path)}&size=small&mtime=${encodeURIComponent(im.mtime || '')}" alt="" />
      <span class="sel-x">✕</span></div>`).join('')}</div>`;
  $('#selClear').onclick = () => { selectedTiles.clear(); renderGallery(); };
  $$('#selectedStrip .sel-thumb').forEach((d) => d.querySelector('.sel-x').onclick = () => { selectedTiles.delete(d.dataset.path); renderGallery(); });
}

// ── NAS 폴더 직접 찾기 ────────────────────────────────────────────────────────
let treePath = null; // null = 최상위 공유목록
$('#toggleTree').onclick = () => { const el = $('#treePanel'); const show = el.classList.contains('hidden'); el.classList.toggle('hidden'); $('#toggleTree').classList.toggle('on', show); if (show) loadTree(null); };
async function loadTree(pathArg) {
  treePath = pathArg;
  const dirsEl = $('#treeDirs'); dirsEl.innerHTML = '<span class="muted">불러오는 중…</span>';
  try {
    const d = await api('/api/tree' + (pathArg ? '?path=' + encodeURIComponent(pathArg) : ''));
    if (!pathArg) {
      $('#treeCrumb').textContent = 'NAS 최상위 (공유 폴더)';
      $('#treeUp').disabled = true; $('#treeLoad').disabled = true; $('#treeLoad').textContent = '이 폴더 이미지 불러오기';
      dirsEl.innerHTML = (d.shares || []).map((s) => `<button class="tree-dir" data-path="${esc(s.path)}">${esc(s.name)}</button>`).join('') || '<span class="muted">공유 폴더 없음</span>';
    } else {
      $('#treeCrumb').textContent = pathArg;
      $('#treeUp').disabled = false; $('#treeLoad').disabled = false;
      $('#treeLoad').textContent = `이 폴더 이미지 불러오기${d.imageCount ? ` (${d.imageCount}장~)` : ''}`;
      dirsEl.innerHTML = (d.dirs || []).map((x) => `<button class="tree-dir" data-path="${esc(x.path)}">${esc(x.name)}</button>`).join('') || '<span class="muted">하위 폴더 없음 — 아래 버튼으로 이미지를 불러오세요.</span>';
    }
    $$('#treeDirs .tree-dir').forEach((b) => b.onclick = () => loadTree(b.dataset.path));
  } catch (e) { dirsEl.innerHTML = '오류: ' + esc(e.message); }
}
$('#treeUp').onclick = () => { if (!treePath) return; loadTree(treePath.replace(/\/[^/]+$/, '') || null); };
$('#treeLoad').onclick = async () => {
  if (!treePath) return;
  const meta = $('#imgMeta'); meta.textContent = '폴더 이미지 불러오는 중…'; recPicks = null; // 선택 이미지 유지
  try {
    const d = await api('/api/list-images?path=' + encodeURIComponent(treePath));
    const leaf = treePath.split('/').slice(-1)[0];
    galleryImages = (d.images || []).map((im) => ({ ...im, hotel: leaf }));
    currentTarget = { hotel: leaf, code: '' };
    meta.textContent = `${d.count || 0}장 · [직접 찾기] ${treePath.split('/').slice(-2).join('/')}`;
    renderGallery();
  } catch (e) { meta.textContent = '오류: ' + e.message; }
};
function openLightbox(path) { $('#lightboxImg').src = `/api/thumb?path=${encodeURIComponent(path)}&size=large`; $('#lightbox').classList.remove('hidden'); }
$('#lightbox').onclick = () => $('#lightbox').classList.add('hidden');

$('#downloadImages').onclick = async () => {
  if (!selectedTiles.size) return alert('다운로드할 이미지를 선택하세요.');
  for (const path of selectedTiles.keys()) { const a = document.createElement('a'); a.href = '/api/original?path=' + encodeURIComponent(path); a.download = ''; document.body.appendChild(a); a.click(); a.remove(); await new Promise((r) => setTimeout(r, 500)); }
};
$('#recImages').onclick = async () => {
  if (!allImages().length) return alert('먼저 이미지를 불러오거나 업로드하세요.');
  const banner = $('#imgRecBanner'); banner.classList.remove('hidden'); banner.innerHTML = '<span class="spinner"></span> 후보 이미지 준비 중…';
  try {
    const items = allImages().slice(0, 60).map((im) => ({ path: im.path, hotel: im.hotel, folder: im.folder }));
    const hotel = currentTarget ? currentTarget.hotel : '';
    const { jobId, auto } = await api('/api/images/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hotel, label: selectedContent ? selectedContent.title : '', theme: selectedContent ? selectedContent.title : '', body: selectedContent ? selectedContent.body : '', items }) });
    if (auto) autoBanner(banner, '후보 이미지를 Claude가 직접 보고 추천 중…');
    else showJobBanner(banner, '이미지 추천 요청 처리해줘', '후보를 Claude가 직접 보고 추천합니다');
    pollImageRec(jobId, banner, auto);
  } catch (e) { banner.innerHTML = '오류: ' + esc(e.message); }
};
function pollImageRec(jobId, banner, auto) {
  let tries = 0;
  const t = setInterval(async () => {
    tries++;
    try {
      const s = await api('/api/images/job?id=' + jobId);
      if (s.status === 'done' && s.picks) { clearInterval(t); recPicks = s.picks; banner.innerHTML = `Claude 추천 ${s.picks.length}장 (초록 테두리). 마우스를 올리면 추천 이유가 보여요.`; renderGallery(); return; }
      if (auto && tries === 60) showJobBanner(banner, '이미지 추천 요청 처리해줘', '자동 처리가 지연되네요. 이 문구를 입력하면 수동으로 처리돼요.');
    } catch (e) { clearInterval(t); banner.innerHTML = '오류: ' + esc(e.message); }
  }, 1500);
}
$('#confirmImages').onclick = async () => {
  const imgs = selectedTiles.size ? [...selectedTiles.values()] : (recPicks || []).map((pk) => allImages().find((im) => im.path === pk.nasPath)).filter(Boolean);
  if (!imgs.length) return alert('이미지를 선택하거나 Claude 추천을 받은 뒤 컨펌하세요.');
  const payload = imgs.map((im) => ({ nasPath: im.path, hotel: im.hotel, folder: im.folder, name: im.name, mtime: im.mtime }));
  await api('/api/images/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ images: payload }) });
  markDone(4); goStep(5);
};

// ── ④ 미리보기 ───────────────────────────────────────────────────────────────
async function renderPreviews() {
  const d = await api('/api/preview');
  window.renderPrizmPreviews($('#previewArea'), d.content, d.images, d.products, d.matches || {}, saveMatches);
}
async function saveMatches(matches) {
  try { await api('/api/content/matches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ matches }) }); } catch {}
}

// ── ⑥ 발행(등록) ─────────────────────────────────────────────────────────────
let pubQueue = [];
let pubSel = null; // 편집 중인 항목 id
const DOMAIN_LABEL = { common: '공통', domestic: '국내', overseas: '해외' };
const MEDIA_LABEL = { off: '② 상품/쇼룸만(OFF)', normal: '① 이미지+상품/쇼룸(normal)', custom: '③ 이미지↔상품/쇼룸 매칭(custom)' };
const PUB_STATUS = { draft: '초안', requested: '발행 대기', publishing: '발행 중…', published: '발행됨', failed: '실패' };

$$('input[name="pubFormat"]').forEach((r) => r.onchange = async () => {
  try { await api('/api/publish/format', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: r.value }) }); } catch {}
});
$('#toPublish').onclick = async () => {
  const chosen = document.querySelector('input[name="pubFormat"]:checked');
  if (!chosen) return alert('발행 형태(①/②/③)를 선택하세요.');
  try { await api('/api/publish/format', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: chosen.value }) }); } catch {}
  await addCurrentToQueue(); goStep(6);
};
$('#pubAddCurrent').onclick = () => addCurrentToQueue();

async function addCurrentToQueue() {
  try {
    const { draft } = await api('/api/publish/draft');
    const { id } = await api('/api/publish/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item: draft }) });
    await loadPubQueue(); pubSel = id; renderPubList(); renderPubEditor();
  } catch (e) { alert('추가 실패: ' + e.message); }
}
async function loadPubQueue() { const { items } = await api('/api/publish/queue'); pubQueue = items; $('#pubCount').textContent = items.length; }
async function renderPublishStep() { try { await loadPubQueue(); } catch {} if (!pubCurrent() && pubQueue[0]) pubSel = pubQueue[0].id; renderPubList(); renderPubEditor(); }
function pubCurrent() { return pubQueue.find((x) => x.id === pubSel); }

function renderPubList() {
  const el = $('#pubList');
  if (!pubQueue.length) { el.innerHTML = '<div class="muted sm">대기 항목이 없어요. 미리보기에서 형태를 골라 추가하세요.</div>'; return; }
  el.innerHTML = pubQueue.map((it) => `<div class="pub-item ${it.id === pubSel ? 'sel' : ''}" data-id="${esc(it.id)}">
    <div class="pub-item-t">${esc((it.content && it.content.title) || '(제목 없음)')}</div>
    <div class="pub-item-m"><span class="badge ${it.status === 'published' ? 'ok' : it.status === 'requested' ? 'warn' : ''}">${PUB_STATUS[it.status] || '초안'}</span> <span class="badge">${DOMAIN_LABEL[it.domain] || it.domain}</span> <span class="badge">${MEDIA_LABEL[it.mediaMode] || it.mediaMode}</span></div></div>`).join('');
  $$('#pubList .pub-item').forEach((d) => d.onclick = () => { pubSel = d.dataset.id; renderPubList(); renderPubEditor(); });
}

function pubItemRow(x, i, isCustom, isShowroom) {
  // 노출 종류에 따라 이름 셀을 하나만: 쇼룸 노출=쇼룸명(수정 가능), 상품 노출=상품명(고정)
  const nameCell = isShowroom
    ? `<td><input class="input xs pf-sr" value="${esc(x.showroomName || '')}" placeholder="쇼룸명" /></td>`
    : `<td>${esc(x.productName || '')}${x.productId ? ` <span class="muted sm">${esc(x.productId)}</span>` : ''}</td>`;
  return `<tr data-i="${i}">${nameCell}${isCustom ? `<td><input class="input xs pf-desc" maxlength="14" value="${esc(x.description || '')}" placeholder="≤14자" /></td>` : ''}<td><button class="btn xs pf-item-del">✕</button></td></tr>`;
}

function renderPubEditor() {
  const it = pubCurrent(); const el = $('#pubEditor');
  if (!it) { el.innerHTML = '<div class="muted">왼쪽에서 항목을 선택하거나, 미리보기에서 형태를 골라 추가하세요.</div>'; return; }
  const c = it.content || {}; const isCustom = it.mediaMode === 'custom'; const isOff = it.mediaMode === 'off';
  const isShowroom = it.exposure === 'showroom'; // 노출 종류: 쇼룸이면 쇼룸명만, 상품이면 상품명만
  el.innerHTML = `<div class="pub-form">
    <div class="pf-row"><label>발행 도메인</label><div class="pf-radios">
      ${['common', 'domestic', 'overseas'].map((d) => `<label><input type="radio" name="pf-domain" value="${d}" ${it.domain === d ? 'checked' : ''}/> ${DOMAIN_LABEL[d]}</label>`).join('')}</div></div>
    <div class="pf-row"><label>발행 주체(쇼룸)</label><input class="input" id="pf-showroom" value="${esc(it.publisherShowroom || '')}" placeholder="국내=체크인 / 해외=인트립 / 공통=직접 입력" /></div>
    <div class="pf-row"><label>제목 <span class="muted sm">(≤24)</span></label><input class="input" id="pf-title" maxlength="24" value="${esc(c.title || '')}" /><span class="muted sm" id="pf-title-c">${(c.title || '').length}/24</span></div>
    <div class="pf-row"><label>내용</label><textarea class="input" id="pf-body" rows="4">${esc(c.body || '')}</textarea></div>
    <div class="pf-row"><label>미디어</label><div><span class="badge">${MEDIA_LABEL[it.mediaMode] || it.mediaMode}</span> <span class="muted sm">${isOff ? '이미지 없이 상품/쇼룸만' : '이미지 ' + ((it.images || []).length) + '장'}</span></div></div>
    <div class="pf-row full"><label>아이템 (${isShowroom ? '쇼룸' : '상품'})</label>
      <div class="pf-items"><table class="pf-table"><thead><tr><th>${isShowroom ? '쇼룸명' : '상품명'}</th>${isCustom ? '<th>설명(≤14)</th>' : ''}<th></th></tr></thead>
        <tbody id="pf-item-rows">${(it.items || []).map((x, i) => pubItemRow(x, i, isCustom, isShowroom)).join('')}</tbody></table>
        <div class="pf-item-add">${isShowroom ? '<button class="btn sm" id="pf-add-showroom">+ 쇼룸 추가</button>' : ''}${isCustom ? '<button class="btn sm" id="pf-gen-desc">설명 자동생성</button>' : ''}</div></div></div>
    <div class="pf-row full"><label>필터 키워드 <span class="muted sm">(없으면 신규로 등록)</span></label>
      <div class="pf-kw"><div id="pf-kw-list" class="chips"></div><div class="row gap"><input class="input sm" id="pf-kw-input" placeholder="키워드 입력 후 Enter" /><label class="muted sm"><input type="checkbox" id="pf-kw-new"/> 신규 등록</label></div></div></div>
    <div class="pf-row"><label>전시 순서 <span class="muted sm">(선택)</span></label><span class="row gap"><input class="input sm" id="pf-order" type="number" value="${it.displayOrder ?? ''}" placeholder="고정 위치 필요시" /><label class="muted sm"><input type="checkbox" id="pf-visible" ${it.displayVisible !== false ? 'checked' : ''}/> 노출</label></span></div>
    <div class="pf-row"><label>전시 기간 <span class="muted sm">(필수)</span></label>
      <span class="row gap"><input class="input sm" id="pf-start" type="datetime-local" value="${esc((it.displayPeriod && it.displayPeriod.start) || '')}" /> ~ <input class="input sm" id="pf-end" type="datetime-local" value="${esc((it.displayPeriod && it.displayPeriod.end) || '')}" ${it.displayPeriod && it.displayPeriod.unlimited ? 'disabled' : ''}/><label class="muted sm"><input type="checkbox" id="pf-unlimited" ${it.displayPeriod && it.displayPeriod.unlimited ? 'checked' : ''}/> 무기한</label></span></div>
    <div class="pf-actions"><button class="btn primary" id="pf-save">저장</button><button class="btn" id="pf-publish">발행 실행 (Phase 2)</button><button class="btn danger" id="pf-del">삭제</button></div>
  </div>`;
  wirePubEditor(it);
}

function collectItems(it) {
  return $$('#pf-item-rows tr').map((tr, i) => { const base = (it.items && it.items[i]) || { kind: 'showroom' }; const sr = tr.querySelector('.pf-sr'); const d = tr.querySelector('.pf-desc'); return { ...base, showroomName: sr ? sr.value : base.showroomName, description: d ? d.value : (base.description || '') }; });
}
function renderKw(it) {
  const el = $('#pf-kw-list'); if (!el) return; const kws = it.filterKeywords || [];
  el.innerHTML = kws.map((k, i) => `<span class="chip">${esc(k.name)}${k.isNew ? ' <span class="muted sm">(신규)</span>' : ''} <b class="kw-x" data-i="${i}">✕</b></span>`).join('') || '<span class="muted sm">없음</span>';
  $$('#pf-kw-list .kw-x').forEach((b) => b.onclick = () => { it.filterKeywords.splice(+b.dataset.i, 1); renderKw(it); });
}
function wirePubEditor(it) {
  const t = $('#pf-title'); if (t) t.oninput = () => { $('#pf-title-c').textContent = t.value.length + '/24'; };
  const un = $('#pf-unlimited'); if (un) un.onchange = () => { const e = $('#pf-end'); if (e) e.disabled = un.checked; };
  const addSr = $('#pf-add-showroom'); if (addSr) addSr.onclick = () => { it.items = collectItems(it); it.items.push({ kind: 'showroom', showroomName: '', description: '' }); renderPubEditor(); };
  $$('#pf-item-rows .pf-item-del').forEach((b) => b.onclick = () => { const i = +b.closest('tr').dataset.i; it.items = collectItems(it); it.items.splice(i, 1); renderPubEditor(); });
  const gen = $('#pf-gen-desc'); if (gen) gen.onclick = () => genDescriptions(it);
  renderKw(it);
  const kwIn = $('#pf-kw-input'); if (kwIn) kwIn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = kwIn.value.trim(); if (v) { it.filterKeywords = it.filterKeywords || []; it.filterKeywords.push({ name: v, isNew: $('#pf-kw-new').checked }); kwIn.value = ''; renderKw(it); } } };
  $('#pf-save').onclick = () => savePubItem(it);
  $('#pf-publish').onclick = () => runPublish(it);
  $('#pf-del').onclick = async () => { if (!confirm('대기목록에서 삭제할까요?')) return; await api('/api/publish/queue?id=' + encodeURIComponent(it.id), { method: 'DELETE' }); pubSel = null; await loadPubQueue(); if (pubQueue[0]) pubSel = pubQueue[0].id; renderPubList(); renderPubEditor(); };
}
function collectPubItem(it) {
  it.domain = (document.querySelector('input[name="pf-domain"]:checked') || {}).value || it.domain;
  it.publisherShowroom = $('#pf-showroom').value.trim();
  it.content = it.content || {}; it.content.title = $('#pf-title').value.trim(); it.content.body = $('#pf-body').value;
  it.items = collectItems(it);
  it.displayOrder = $('#pf-order').value === '' ? null : Number($('#pf-order').value);
  it.displayVisible = $('#pf-visible').checked;
  it.displayPeriod = { start: $('#pf-start').value, end: $('#pf-end').value, unlimited: $('#pf-unlimited').checked };
  return it;
}
async function savePubItem(it) {
  collectPubItem(it);
  if (!it.content.title && !it.content.body) return alert('제목 또는 내용 중 1개는 필요합니다.');
  if (!it.publisherShowroom) return alert('발행 주체(쇼룸)를 입력하세요.');
  if (!it.displayPeriod.start) return alert('전시 시작일시는 필수입니다.');
  if (!it.displayPeriod.unlimited && !it.displayPeriod.end) return alert('전시 종료일시를 입력하거나 무기한을 선택하세요.');
  try { await api('/api/publish/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item: it }) }); await loadPubQueue(); renderPubList(); alert('저장했습니다.'); } catch (e) { alert('저장 실패: ' + e.message); }
}
// 발행 실행 — 버튼만 누르면 스튜디오가 헤드리스(Playwright)로 백오피스에 직접 등록.
async function runPublish(it) {
  collectPubItem(it);
  if (!it.content.title && !it.content.body) return alert('제목 또는 내용 중 1개는 필요합니다.');
  if (!it.publisherShowroom) return alert('발행 주체(쇼룸)를 입력하세요.');
  if (!it.displayPeriod.start) return alert('전시 시작일시는 필수입니다.');
  if (!it.displayPeriod.unlimited && !it.displayPeriod.end) return alert('전시 종료일시를 입력하거나 무기한을 선택하세요.');
  if (!(it.items || []).length) return alert('노출할 상품/쇼룸 아이템이 없습니다.');
  // 발행 환경 점검
  let office = {}; try { office = await api('/api/publish/office-status'); } catch {}
  if (!office.playwrightOk) return alert('Playwright가 설치되지 않았습니다.\n터미널에서:\n  npm i playwright && npx playwright install chromium');
  if (!office.sessionOk) return alert('백오피스 로그인 세션이 없습니다.\n터미널에서 한 번만:\n  node publish-login.js\n(브라우저가 열리면 로그인 후 Enter → 세션 저장)');
  if (!confirm('이 콘텐츠를 실제 백오피스에 지금 등록할까요?\n' + (office.baseUrl || ''))) return;
  try {
    await api('/api/publish/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item: it }) });
    await api('/api/publish/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: it.id }) });
    await loadPubQueue(); renderPubList(); renderPubEditor();
    pollPublishStatus(it.id); // 진행 상태 폴링
  } catch (e) { alert('발행 실패: ' + e.message); }
}
async function pollPublishStatus(id) {
  let tries = 0;
  const t = setInterval(async () => {
    tries++;
    let items; try { ({ items } = await api('/api/publish/queue')); } catch { return; }
    const x = items.find((y) => y.id === id); if (!x) { clearInterval(t); return; }
    pubQueue = items; renderPubList(); if (pubSel === id) renderPubEditor();
    if (x.status === 'published') { clearInterval(t); alert('발행 완료! 백오피스에 등록됐습니다.'); }
    else if (x.status === 'failed') { clearInterval(t); alert('발행 실패: ' + (x.error || '알 수 없음')); }
    else if (tries > 90) { clearInterval(t); }
  }, 2000);
}
async function genDescriptions(it) {
  it.items = collectItems(it);
  const gen = $('#pf-gen-desc'); if (gen) { gen.disabled = true; gen.textContent = '생성 중…'; }
  try {
    const { id } = await api('/api/publish/description', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: it.items }) });
    let tries = 0;
    const poll = setInterval(async () => {
      tries++; let j; try { j = await api('/api/publish/description/' + id); } catch { return; }
      if (j.status === 'done' && j.descriptions) { clearInterval(poll); (j.descriptions || []).forEach((d) => { if (it.items[d.i]) it.items[d.i].description = (d.description || '').slice(0, 14); }); renderPubEditor(); }
      else if (tries > 120) { clearInterval(poll); if (gen) { gen.disabled = false; gen.textContent = '설명 자동생성'; } alert('생성이 지연됩니다. 잠시 후 다시 시도하세요.'); }
    }, 2000);
  } catch (e) { if (gen) { gen.disabled = false; gen.textContent = '설명 자동생성'; } alert('실패: ' + e.message); }
}


// ── 노출 캘린더 (백오피스 게시글 · 전시기간 기준) ─────────────────────────────
const calState = { view: 'week', scope: 'all', cursor: startOfDay(new Date()), live: true, sched: true, ended: false, posts: null, wired: false };
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function dayMs(d) { const s = startOfDay(d).getTime(); return { s, e: s + 86400000 - 1 }; }
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const fmtMD = (d) => `${d.getMonth() + 1}.${d.getDate()}`;
const fmtFull = (d) => `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}(${WD[d.getDay()]})`;
// 게시글의 현재시각 기준 상태
function postStatus(p, now) { if (p.start && p.start > now) return 'sched'; if (p.end && p.end < now) return 'ended'; return 'live'; }
function scopeOk(p) { return calState.scope === 'all' || (calState.scope === 'domestic' ? (p.category === 'domestic' || p.category === 'common') : (p.category === 'overseas' || p.category === 'common')); }
// 현재 필터(도메인+상태)에 맞는 게시글(공개=PUBLIC만 노출로 간주)
function calFiltered() {
  const now = Date.now();
  return (calState.posts || []).filter((p) => {
    if (p.status !== 'PUBLIC') return false;
    if (!p.start) return false;
    if (!scopeOk(p)) return false;
    const st = postStatus(p, now);
    return (st === 'live' && calState.live) || (st === 'sched' && calState.sched) || (st === 'ended' && calState.ended);
  });
}
function overlapsDay(p, d) { const { s, e } = dayMs(d); return p.start <= e && (p.end == null || p.end >= s); }
function postsOnDay(d) { return calFiltered().filter((p) => overlapsDay(p, d)); }       // 그 날 노출중(전시기간 겹침)
function startsOnDay(d) { const { s, e } = dayMs(d); return calFiltered().filter((p) => p.start >= s && p.start <= e); } // 그 날 노출 시작
function endsOnDay(d) { const { s, e } = dayMs(d); return calFiltered().filter((p) => p.end && p.end >= s && p.end <= e); }
// 리스트 정렬: 그 날 노출 시작하는 항목을 먼저, 그 다음 시작시각 순
function startsFirst(d) { const { s, e } = dayMs(d); const on = (p) => (p.start >= s && p.start <= e) ? 0 : 1; return (a, b) => on(a) - on(b) || a.start - b.start; }

// 로그인 세션 만료 임박/만료 경고 배너(24시간 이내면 경고)
async function renderSessionWarn() {
  const el = $('#calSessionWarn'); if (!el) return;
  let s; try { s = await api('/api/office/session'); } catch { el.classList.add('hidden'); return; }
  const how = '<b>매니저 오피스에 다시 로그인해 주세요.</b><br><span class="warn-how">터미널에서 <code>node publish-login.js</code> 실행 → 열리는 브라우저에서 로그인 → 터미널로 돌아와 Enter → 캘린더 "새로고침"</span>';
  if (!s.exists) { el.className = 'cal-warn warn-err'; el.innerHTML = `백오피스 로그인 세션이 없습니다. ${how}`; return; }
  if (s.expired) { el.className = 'cal-warn warn-err'; el.innerHTML = `⚠ 매니저 오피스 로그인 세션이 만료됐습니다. ${how}`; return; }
  const ms = s.expiresInMs || 0;
  if (ms > 0 && ms < 24 * 3600 * 1000) {
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    const when = new Date(s.exp).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    el.className = 'cal-warn warn-soon'; el.innerHTML = `⏰ 매니저 오피스 로그인 세션이 곧 만료됩니다 — ${esc(when)} (약 ${h}시간 ${m}분 뒤). 지금 미리 다시 로그인해 두세요.<br><span class="warn-how">터미널에서 <code>node publish-login.js</code> 실행 → 로그인 → Enter.</span>`;
    return;
  }
  el.className = 'cal-warn hidden';
}
async function loadCalendar(force) {
  wireCalendar();
  renderSessionWarn();
  const body = $('#calBody'); if (!body) return;
  if (calState.posts === null || force) {
    body.innerHTML = '<div class="muted sm">불러오는 중…</div>';
    try { const r = await api('/api/office/posts' + (force ? '?force=1' : '')); calState.posts = r.posts || []; }
    catch (e) { body.innerHTML = `<div class="cal-err">게시글을 불러오지 못했습니다: ${esc(e.message)}<br><span class="muted sm">세션이 만료됐다면 터미널에서 <code>node publish-login.js</code> 로 다시 로그인하세요.</span></div>`; return; }
  }
  renderCalendar();
}
function wireCalendar() {
  if (calState.wired) return; calState.wired = true;
  $('#calPrev').onclick = () => { calState.cursor = addDays(calState.cursor, calState.view === 'day' ? -1 : calState.view === 'week' ? -7 : -30); if (calState.view === 'month') calState.cursor = new Date(calState.cursor.getFullYear(), calState.cursor.getMonth(), 1); renderCalendar(); };
  $('#calNext').onclick = () => { calState.cursor = addDays(calState.cursor, calState.view === 'day' ? 1 : calState.view === 'week' ? 7 : 30); if (calState.view === 'month') calState.cursor = new Date(calState.cursor.getFullYear(), calState.cursor.getMonth(), 1); renderCalendar(); };
  $('#calToday').onclick = () => { calState.cursor = startOfDay(new Date()); renderCalendar(); };
  $$('#calView .seg-b').forEach((b) => b.onclick = () => { calState.view = b.dataset.view; $$('#calView .seg-b').forEach((x) => x.classList.toggle('active', x === b)); if (calState.view === 'month') calState.cursor = new Date(calState.cursor.getFullYear(), calState.cursor.getMonth(), 1); renderCalendar(); });
  $$('#calScopeSeg .seg-b').forEach((b) => b.onclick = () => { calState.scope = b.dataset.scope; $$('#calScopeSeg .seg-b').forEach((x) => x.classList.toggle('active', x === b)); renderCalendar(); });
  $('#calLive').onchange = () => { calState.live = $('#calLive').checked; renderCalendar(); };
  $('#calSched').onchange = () => { calState.sched = $('#calSched').checked; renderCalendar(); };
  $('#calEnded').onchange = () => { calState.ended = $('#calEnded').checked; renderCalendar(); };
  $('#calRefresh').onclick = () => loadCalendar(true);
}
function calSummary() {
  const now = Date.now();
  let live = 0, sched = 0, ended = 0;
  (calState.posts || []).filter((p) => p.status === 'PUBLIC' && p.start && scopeOk(p)).forEach((p) => { const s = postStatus(p, now); if (s === 'live') live++; else if (s === 'sched') sched++; else ended++; });
  const today = postsOnDay(startOfDay(new Date())).length;
  $('#calSummary').innerHTML =
    `<span class="cal-pill cal-live">노출중 ${live}</span><span class="cal-pill cal-sched">노출예정 ${sched}</span><span class="cal-pill cal-ended">종료 ${ended}</span>`
    + `<span class="cal-today-n">오늘 노출 <b>${today}</b>건</span>`;
}
function postChip(p, now, cls) { const st = postStatus(p, now); const per = fmtMD(new Date(p.start)) + '~' + (p.end ? fmtMD(new Date(p.end)) : '무기한'); return `<div class="cal-chip cal-${st}${cls ? ' ' + cls : ''}" title="${esc(p.title)} · ${per} · ${esc(p.publisher)}"><span class="cal-dot"></span>${esc(p.title)}</div>`; }
const WEEK_CHIP_LIMIT = 15; // 요일별 최대 노출 칩 수(초과분은 더보기)
function renderCalendar() {
  calSummary();
  const now = Date.now();
  const body = $('#calBody'); const label = $('#calRangeLabel');
  if (calState.view === 'day') {
    const d = calState.cursor; label.textContent = fmtFull(d);
    const list = postsOnDay(d).sort(startsFirst(d));
    const starting = startsOnDay(d).length, ending = endsOnDay(d).length;
    body.innerHTML = `<div class="cal-day">
      <div class="cal-day-h">${fmtFull(d)} <span class="cal-cnt-live">노출중 ${list.length}건</span><span class="cal-cnt-start">노출 시작 ${starting}건</span>${ending ? `<span class="cal-cnt-end">종료 ${ending}건</span>` : ''}</div>
      <div class="cal-day-list">${list.map((p) => calRow(p, now, d)).join('') || '<div class="muted sm">이 날 노출되는 게시글이 없어요.</div>'}</div></div>`;
    $('#calDetail').innerHTML = '';
  } else if (calState.view === 'week') {
    const start = addDays(calState.cursor, -calState.cursor.getDay()); // 일요일 시작
    label.textContent = `${fmtMD(start)} ~ ${fmtMD(addDays(start, 6))}`;
    let cols = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i); const on = postsOnDay(d).sort((a, b) => a.start - b.start); const st = startsOnDay(d).length;
      const isToday = startOfDay(new Date()).getTime() === d.getTime();
      const chips = on.map((p, j) => postChip(p, now, j >= WEEK_CHIP_LIMIT ? 'cal-hidden' : '')).join('') || '<div class="cal-empty">·</div>';
      const more = on.length > WEEK_CHIP_LIMIT ? `<button type="button" class="cal-more">＋ ${on.length - WEEK_CHIP_LIMIT}개 더보기</button>` : '';
      cols += `<div class="cal-wcol${isToday ? ' cal-td' : ''}"><div class="cal-wch"><span class="cal-wd">${WD[d.getDay()]} ${fmtMD(d)}</span>
          <span class="cal-wcounts"><span class="cal-cnt-live" title="이 날 노출중">노출 ${on.length}</span><span class="cal-cnt-start" title="이 날 노출 시작">시작 ${st}</span></span></div>
        <div class="cal-wlist">${chips}${more}</div></div>`;
    }
    body.innerHTML = `<div class="cal-week">${cols}</div>`;
    $$('#calBody .cal-more').forEach((btn) => btn.onclick = () => { const list = btn.closest('.cal-wlist'); list.querySelectorAll('.cal-chip.cal-hidden').forEach((c) => c.classList.remove('cal-hidden')); btn.remove(); });
    $('#calDetail').innerHTML = '';
  } else { // month
    const first = new Date(calState.cursor.getFullYear(), calState.cursor.getMonth(), 1);
    label.textContent = `${first.getFullYear()}년 ${first.getMonth() + 1}월`;
    const gridStart = addDays(first, -first.getDay());
    const todayMs = startOfDay(new Date()).getTime();
    let cells = WD.map((w) => `<div class="cal-mh">${w}</div>`).join('');
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i); const inMonth = d.getMonth() === first.getMonth();
      const n = postsOnDay(d).length; const starting = startsOnDay(d).length;
      const isToday = d.getTime() === todayMs;
      const heat = n === 0 ? '' : n < 3 ? ' h1' : n < 6 ? ' h2' : ' h3';
      cells += `<div class="cal-cell${inMonth ? '' : ' cal-off'}${isToday ? ' cal-td' : ''}${heat}" data-ts="${d.getTime()}">
        <div class="cal-cn">${d.getDate()}</div>
        <div class="cal-mcnts">${n ? `<span class="cal-cnt-live" title="노출중">노출 ${n}</span>` : ''}${starting ? `<span class="cal-cnt-start" title="노출 시작">시작 ${starting}</span>` : ''}</div></div>`;
    }
    body.innerHTML = `<div class="cal-month">${cells}</div>`;
    $$('#calBody .cal-cell').forEach((c) => c.onclick = () => { const d = new Date(+c.dataset.ts); showDayDetail(d); });
    $('#calDetail').innerHTML = '<div class="muted sm">날짜를 클릭하면 그 날 노출되는 게시글을 볼 수 있어요.</div>';
  }
}
function calRow(p, now, d) {
  const st = postStatus(p, now); const lbl = st === 'live' ? '노출중' : st === 'sched' ? '노출예정' : '종료';
  const per = fmtFull(new Date(p.start)) + ' ~ ' + (p.end ? fmtFull(new Date(p.end)) : '무기한');
  const domain = p.category === 'domestic' ? '국내' : p.category === 'overseas' ? '해외' : '공통';
  const startsToday = d && p.start >= dayMs(d).s && p.start <= dayMs(d).e; // 이 날 노출 시작
  return `<div class="cal-lrow cal-${st}${startsToday ? ' cal-starts' : ''}"><span class="cal-badge cal-${st}">${lbl}</span>${startsToday ? '<span class="cal-badge cal-startrow">이 날 시작</span>' : ''}<span class="cal-lt">${esc(p.title)}</span><span class="cal-lm">${domain} · ${esc(p.publisher || '')} · ${esc(per)}</span></div>`;
}
function showDayDetail(d) {
  const now = Date.now(); const list = postsOnDay(d).sort(startsFirst(d));
  const starting = startsOnDay(d).length, ending = endsOnDay(d).length;
  $('#calDetail').innerHTML = `<div class="cal-detail-h">${fmtFull(d)} <span class="cal-cnt-live">노출중 ${list.length}건</span><span class="cal-cnt-start">노출 시작 ${starting}건</span>${ending ? `<span class="cal-cnt-end">종료 ${ending}건</span>` : ''}</div>`
    + (list.map((p) => calRow(p, now, d)).join('') || '<div class="muted sm">이 날 노출되는 게시글이 없어요.</div>');
}

// ── 초기화 ───────────────────────────────────────────────────────────────────
(async function init() {
  loadThemes();
  loadRegions();
  renderFormChips();
  loadProductTypes();
  loadMe();
  refreshSaved();
  loadSchedules();
  loadReferences();
  try {
    const s = await api('/api/state');
    if (s.state.selectedContent) selectedContent = s.state.selectedContent;
    loadProducts();
  } catch {}
})();
