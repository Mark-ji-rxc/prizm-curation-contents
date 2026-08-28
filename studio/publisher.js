'use strict';
// ── 백오피스 게시글 자동 발행(Playwright headless) ────────────────────────────
// publishItem(item, stagedFiles) → 로그인 세션 재사용, create 폼 자동 입력·저장.
// item: 발행 큐 항목. stagedFiles: [{localPath,name}] (stage-images 결과, 미디어 ON일 때).
const fs = require('fs');
const { chromium } = require('playwright');
const CFG = require('./_officecfg');

const DOMAIN_RADIO = { common: 'NONE', domestic: 'DOMESTIC', overseas: 'INTERNATIONAL' };

async function publishItem(item, stagedFiles, customImages) {
  if (!fs.existsSync(CFG.sessionFile)) throw new Error('로그인 세션 없음 — 먼저 `node publish-login.js` 로 로그인하세요.');
  const browser = await chromium.launch({ headless: CFG.headless });
  const log = [];
  const step = (m) => { log.push(m); console.log('[publish]', m); };
  let page;
  try {
    const ctx = await browser.newContext({ storageState: CFG.sessionFile });
    page = await ctx.newPage();
    await page.goto(CFG.baseUrl + '/display/discover/post/create', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    // 세션 만료/미로그인 감지: 로그인 폼(email)이 보이거나 create 폼(쇼룸 검색)이 안 뜨면
    const loggedOut = (await page.locator('input[type=email]').count()) > 0;
    await page.getByPlaceholder('쇼룸 검색').first().waitFor({ timeout: 8000 }).catch(() => {});
    const formReady = (await page.getByPlaceholder('쇼룸 검색').count()) > 0;
    if (loggedOut || !formReady) throw new Error('세션 만료/미로그인 — 터미널에서 `node publish-login.js` 로 로그인하세요.');

    // 1) 발행 도메인
    const domVal = DOMAIN_RADIO[item.domain] || 'NONE';
    await page.locator(`input[type=radio][value="${domVal}"]`).check({ timeout: 8000 });
    step('발행 도메인: ' + item.domain);

    // 2) 발행 주체(쇼룸) — 자동완성 정확 선택
    if (item.publisherShowroom) {
      const sr = page.getByPlaceholder('쇼룸 검색').first();
      await sr.click(); await sr.fill(item.publisherShowroom);
      await page.waitForTimeout(800);
      // "21293 체크인" 형태 옵션 중 이름이 정확히 일치하는 것
      const opt = page.getByRole('option').filter({ hasText: new RegExp('\\d+\\s+' + escapeRe(item.publisherShowroom) + '$') }).first();
      if (await opt.count()) await opt.click();
      else await page.getByRole('option').filter({ hasText: item.publisherShowroom }).first().click({ timeout: 5000 });
      step('발행 주체: ' + item.publisherShowroom);
    }

    // 3) 제목 / 내용
    const boxes = page.getByPlaceholder('제목 또는 내용 중 1개는 입력되어야 합니다.');
    if (item.content && item.content.title) await boxes.nth(0).fill(item.content.title);
    if (item.content && item.content.body) await boxes.nth(1).fill(item.content.body);
    step('제목/내용 입력');

    // 4) 미디어 모드: normal=미디어 ON+상단 업로드 / off·custom=미디어 OFF (custom은 Custom 라디오 + 행별 이미지)
    const isCustom = item.mediaMode === 'custom';
    const mediaToggle = page.locator('label').filter({ has: page.locator('input[type=checkbox]') }).first(); // 미디어 토글
    if (item.mediaMode === 'normal') {
      if (stagedFiles && stagedFiles.length) {
        await page.locator('input[type=file]').first().setInputFiles(stagedFiles.map((f) => f.localPath));
        await page.waitForTimeout(2000);
        step('이미지 업로드 ' + stagedFiles.length + '장');
      }
    } else { // off 또는 custom → 미디어 OFF
      if (await page.getByText(/^ON$/).count()) { await mediaToggle.click(); await page.waitForTimeout(500); step('미디어 OFF'); }
      if (isCustom) { await page.locator('input[type=radio][value="CUSTOM"]').check({ timeout: 5000 }); await page.waitForTimeout(400); step('Custom 모드'); }
    }

    // 5) 아이템 — 상품(goods) 노출: 상품ID → 실패 시 상품명으로 조회해 선택
    //    (크롤 상품ID = PRIZM 전시상품 id 라서 백오피스 goods id와 다를 수 있음 → 패키지류는 이름으로 폴백)
    const goods = (item.items || []).filter((x) => x.kind !== 'showroom' && x.productId);
    if (goods.length) {
      await page.getByRole('button', { name: '상품 조회', exact: true }).click();
      const modal = page.getByRole('dialog').first();
      await modal.waitFor({ timeout: 8000 });
      const picked = [], missed = [];
      for (const g of goods) { if (await selectGoodsInModal(page, modal, g)) picked.push(g); else missed.push(g); }
      if (missed.length) throw new Error('상품 조회 실패 — 백오피스에서 찾지 못한 상품(상품ID/상품명 모두): ' + missed.map((m) => (m.productId + ' ' + (m.productName || '')).trim()).join(' / ') + (picked.length ? ' · (일부 상품은 미등록 방지를 위해 저장하지 않음)' : ''));
      await modal.getByRole('button', { name: '적용' }).click({ timeout: 8000 });
      await page.waitForTimeout(800);
      step('상품 ' + picked.length + '개 추가');
      if (isCustom) await fillCustomRows(page, goods, customImages, step);
    }
    // (쇼룸 노출은 별도 — 아이템 쇼룸 탭. 후속 확장)

    // 6) 전시 기간(필수)
    const dp = item.displayPeriod || {};
    if (dp.start) await page.locator('input[type=datetime-local]').first().fill(dp.start.slice(0, 16));
    if (dp.unlimited) {
      await page.getByText('무기한', { exact: true }).locator('xpath=preceding-sibling::*//input[@type="checkbox"] | ../input[@type="checkbox"]').first().check().catch(async () => {
        await page.locator('input[type=checkbox]').last().check();
      });
      step('전시기간: 무기한');
    } else if (dp.end) {
      await page.locator('input[type=datetime-local]').nth(1).fill(dp.end.slice(0, 16));
      step('전시기간: ~' + dp.end);
    }

    // 7) 저장
    await page.getByRole('button', { name: '저장' }).click();
    // 완료 다이얼로그 대기
    await page.getByText('게시글이 등록되었습니다').waitFor({ timeout: 20000 });
    step('저장 완료 ✅');
    await browser.close();
    return { ok: true, log };
  } catch (e) {
    let shot = '';
    try { shot = require('path').join(__dirname, 'publish-staging', 'error-' + (item.id || 'x') + '.png'); await page.screenshot({ path: shot, fullPage: true }); } catch {}
    try { await browser.close(); } catch {}
    return { ok: false, error: e.message, log, shot };
  }
}

// custom: 아이템 표의 각 행에 상품별 이미지 + description(14자) 매핑.
// 미디어는 행마다 존재하는 별도 file input이 아니라, 행의 "클립 버튼"(각 행 첫 버튼)을 클릭하면
// 페이지 공용 파일 선택창(filechooser)이 그 행 대상으로 열리는 구조 → filechooser 패턴으로 첨부한다.
async function fillCustomRows(page, goods, customImages, step) {
  const rows = page.locator('table tbody tr');
  const n = await rows.count();
  let descN = 0, imgN = 0;
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const idText = ((await row.locator('td').first().innerText().catch(() => '')) || '').trim();
    if (!/^\d+$/.test(idText)) continue;
    const g = goods.find((x) => String(x.productId) === idText);
    if (!g) continue;
    // Description(14자)
    if (g.description) { const d = row.locator('input[placeholder*="14자"]'); if (await d.count()) { await d.first().fill(String(g.description).slice(0, 14)).catch(() => {}); descN++; } }
    // 미디어 첨부: 행 첫 버튼(클립) 클릭 → filechooser → setFiles
    const local = customImages && customImages[String(g.productId)];
    if (local) {
      try {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 8000 }),
          row.locator('button').first().click(),
        ]);
        await chooser.setFiles(local);
        await page.waitForTimeout(2000); // 업로드 반영 대기
        imgN++;
      } catch (e) { step('행 이미지 첨부 실패(' + idText + '): ' + e.message); }
    }
  }
  step('custom 행별 설정 — 설명 ' + descN + ' · 이미지 ' + imgN + '개');
}

// 상품조회 모달 검색조건 선택 (MUI Select = role=button name "searchType"). 옵션: 전체/상품ID/상품명
async function setSearchType(page, modal, typeName) {
  const sel = modal.getByRole('button', { name: 'searchType' }).first();
  if (!(await sel.count())) return;
  await sel.click();
  await page.waitForTimeout(250);
  await page.getByRole('option', { name: typeName, exact: true }).first().click({ timeout: 5000 }).catch(async () => { await page.keyboard.press('Escape').catch(() => {}); });
  await page.waitForTimeout(250);
}
// 모달에서 검색 실행 후 "실제 결과 행이 있는지"를 반환("데이터가 없습니다"·체크박스 없음이면 false)
async function searchInModal(page, modal, typeName, value) {
  await setSearchType(page, modal, typeName);
  const val = modal.getByRole('textbox').first();
  await val.fill(''); await val.fill(String(value));
  await modal.getByRole('button', { name: '검색' }).click();
  await page.waitForTimeout(1200);
  const rows = modal.locator('table tbody tr');
  if (!(await rows.count())) return false;
  const first = ((await rows.first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  if (/데이터가 없습니다/.test(first)) return false;
  return (await modal.locator('table tbody input[type=checkbox]').count()) > 0;
}
// 크롤 상품명 → 백오피스 검색용 정리: 선두 [..] 태그·"N박" 제거, 공백 정리
function cleanName(name) { return String(name || '').replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s*\d+박\s*/g, ' ').replace(/\s+/g, ' ').trim(); }
// 특수문자 없는 검색 조각(괄호/대괄호 앞부분) — 백오피스 상품명 검색이 특수문자에 약함
function searchFragment(name) { const c = cleanName(name); const cut = c.split(/[([]/)[0].trim(); return (cut.length >= 2 ? cut : c).trim(); }
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
// 결과 행 중 크롤 상품명과 일치하는 행 1건을 고른다(TEST/_copy 제외, 모호하면 null)
async function matchRowByName(modal, fullName) {
  const key = norm(cleanName(fullName));
  if (!key) return null;
  const rows = modal.locator('table tbody tr');
  const n = await rows.count();
  const cands = [];
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const t = ((await row.innerText().catch(() => '')) || '').trim(); // 행 전체 텍스트(상품명 칸 위치가 가변이라 전체로 매칭)
    if (/test|_copy/i.test(t)) continue; // 테스트/복사본 제외
    const tn = norm(t);
    if (tn.includes(key)) cands.push({ row, extra: tn.length - key.length });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.extra - b.extra); // 군더더기 적은(정확) 행 우선
  if (cands.length > 1 && cands[0].extra === cands[1].extra) return null; // 동률 모호 → 실패
  return cands[0].row;
}
async function checkRow(row) {
  const cb = row.locator('input[type=checkbox]').first();
  if (await cb.count()) { await cb.check({ timeout: 6000 }).catch(() => {}); return true; }
  return false;
}
// 상품 1건을 모달에서 선택: 상품ID → 실패 시 상품명(정확 매칭) 폴백
async function selectGoodsInModal(page, modal, g) {
  if (await searchInModal(page, modal, '상품ID', g.productId)) {
    const row = modal.locator('table tbody tr').first();
    if (await checkRow(row)) return true;
  }
  const frag = searchFragment(g.productName);
  if (frag && await searchInModal(page, modal, '상품명', frag)) {
    const row = await matchRowByName(modal, g.productName);
    if (row && await checkRow(row)) return true;
  }
  return false;
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { publishItem, __test: { selectGoodsInModal, cleanName, searchFragment, matchRowByName } };
