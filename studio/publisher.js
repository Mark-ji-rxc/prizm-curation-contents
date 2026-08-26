'use strict';
// ── 백오피스 게시글 자동 발행(Playwright headless) ────────────────────────────
// publishItem(item, stagedFiles) → 로그인 세션 재사용, create 폼 자동 입력·저장.
// item: 발행 큐 항목. stagedFiles: [{localPath,name}] (stage-images 결과, 미디어 ON일 때).
const fs = require('fs');
const { chromium } = require('playwright');
const CFG = require('./_officecfg');

const DOMAIN_RADIO = { common: 'NONE', domestic: 'DOMESTIC', overseas: 'INTERNATIONAL' };

async function publishItem(item, stagedFiles) {
  if (!fs.existsSync(CFG.sessionFile)) throw new Error('로그인 세션 없음 — 먼저 `node publish-login.js` 로 로그인하세요.');
  const browser = await chromium.launch({ headless: CFG.headless });
  const log = [];
  const step = (m) => { log.push(m); console.log('[publish]', m); };
  try {
    const ctx = await browser.newContext({ storageState: CFG.sessionFile });
    const page = await ctx.newPage();
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

    // 4) 미디어 ON/OFF + 이미지 업로드
    const wantMedia = item.mediaMode !== 'off';
    const mediaToggle = page.locator('label').filter({ has: page.locator('input[type=checkbox]') }).first(); // 미디어 토글
    // (기본 ON) — OFF 원하면 끈다
    if (!wantMedia) {
      const on = await page.getByText(/^ON$/).count();
      if (on) { await mediaToggle.click(); step('미디어 OFF'); }
    } else if (stagedFiles && stagedFiles.length) {
      await page.locator('input[type=file]').first().setInputFiles(stagedFiles.map((f) => f.localPath));
      await page.waitForTimeout(2000);
      step('이미지 업로드 ' + stagedFiles.length + '장');
    }

    // 5) 아이템 — 상품(goods) 노출: 상품ID로 상품조회 모달에서 추가
    const goods = (item.items || []).filter((x) => x.kind !== 'showroom' && x.productId);
    if (goods.length) {
      await page.getByRole('button', { name: '상품 조회', exact: true }).click();
      const modal = page.getByRole('dialog').first();
      await modal.waitFor({ timeout: 8000 });
      // 검색조건 → 상품ID
      await setSearchTypeToId(page, modal);
      for (const g of goods) {
        const val = modal.getByRole('textbox').first(); // role=textbox (MUI select 숨은 input 회피)
        await val.fill('');
        await val.fill(String(g.productId));
        await modal.getByRole('button', { name: '검색' }).click();
        await page.waitForTimeout(1200);
        // 결과 첫 행 체크박스(정확 ID 검색이라 1건)
        const cb = modal.locator('table input[type=checkbox]').nth(1); // 0=헤더, 1=첫 행
        await cb.check({ timeout: 6000 }).catch(() => {});
      }
      await modal.getByRole('button', { name: '적용' }).click();
      await page.waitForTimeout(800);
      step('상품 ' + goods.length + '개 추가');
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
    try { await browser.close(); } catch {}
    return { ok: false, error: e.message, log };
  }
}

// 상품조회 모달 검색조건을 "상품ID"로 (MUI Select = role=button name "searchType")
async function setSearchTypeToId(page, modal) {
  const sel = modal.getByRole('button', { name: 'searchType' }).first();
  if (await sel.count()) {
    await sel.click();
    await page.waitForTimeout(300);
    await page.getByRole('option', { name: '상품ID', exact: true }).first().click({ timeout: 5000 });
    await page.waitForTimeout(300);
  }
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { publishItem };
