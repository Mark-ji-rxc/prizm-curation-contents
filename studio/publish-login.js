'use strict';
// ── 백오피스 로그인 세션 저장(최초 1회 / 세션 만료 시) ─────────────────────────
// 실행: node publish-login.js         (스테이지)
//       node publish-login.js prod    (프로덕션 = manager-office.prizm.co.kr)
// 실제 브라우저가 열리면 백오피스에 로그인 → 터미널에서 Enter → 세션 쿠키를 파일로 저장.
// 이후 헤드리스 발행(publisher.js)이 이 세션을 재사용(비밀번호는 저장하지 않음).
const { chromium } = require('playwright');
const CFG = require('./_officecfg');
const OFF = CFG.envConfig(process.argv[2]); // 'prod' 인자 주면 프로덕션, 없으면 스테이지

(async () => {
  const envKo = OFF.env === 'prod' ? '프로덕션' : '스테이지';
  console.log('▶ 백오피스 로그인 세션 저장 도우미 [' + envKo + ']');
  console.log('  대상:', OFF.baseUrl);
  console.log('  세션 저장 위치:', OFF.sessionFile);
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(OFF.baseUrl + '/display/discover/post/list').catch(() => {});
  console.log('\n브라우저가 열렸습니다. ' + envKo + ' 백오피스 계정으로 로그인하세요.');
  console.log('로그인이 끝나면 이 터미널에서 Enter 를 누르세요 → 세션이 저장됩니다.\n');
  await new Promise((resolve) => process.stdin.once('data', resolve));
  await ctx.storageState({ path: OFF.sessionFile });
  console.log('✅ [' + envKo + '] 세션 저장 완료:', OFF.sessionFile);
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('오류:', e.message); process.exit(1); });
