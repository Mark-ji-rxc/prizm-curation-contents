'use strict';
// 백오피스 발행(Playwright) 설정 — studio.config.json 의 office 섹션에서 읽음(없으면 stage 기본).
const path = require('path');
const fs = require('fs');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'studio.config.json'), 'utf8')); } catch {}
const office = cfg.office || {};
module.exports = {
  // 실제 백오피스 배포 시 baseUrl 만 교체하면 동일 동작
  baseUrl: office.baseUrl || 'https://manager-office-stage.prizm.co.kr',
  // 로그인 세션(쿠키) 저장 파일 — publish-login.js 로 생성, headless 발행이 재사용(비번 저장 안 함)
  sessionFile: office.sessionFile || path.join(__dirname, 'office-session.json'),
  headless: office.headless !== false, // 기본 headless. 디버깅 시 config에서 false
};
