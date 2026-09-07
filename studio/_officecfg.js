'use strict';
// 백오피스 발행(Playwright) 설정 — 환경(stage/prod)별 baseUrl·세션파일.
// studio.config.json 의 office 섹션에서 읽음. 하위호환: 평면 office.baseUrl/sessionFile 은 stage 로 취급.
const path = require('path');
const fs = require('fs');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'studio.config.json'), 'utf8')); } catch {}
const office = cfg.office || {};

const DEFAULTS = {
  stage: { baseUrl: 'https://manager-office-stage.prizm.co.kr', sessionFile: 'office-session.json' },
  prod: { baseUrl: 'https://manager-office.prizm.co.kr', sessionFile: 'office-session-prod.json' },
};

// 환경별 설정 반환. env: 'stage'(기본) | 'prod'
function envConfig(env) {
  env = (env === 'prod' || env === 'production') ? 'prod' : 'stage';
  const section = office[env] || {};
  const legacyBase = env === 'stage' ? office.baseUrl : null;       // 하위호환
  const legacySF = env === 'stage' ? office.sessionFile : null;
  const baseUrl = section.baseUrl || legacyBase || DEFAULTS[env].baseUrl;
  const sf = section.sessionFile || legacySF || DEFAULTS[env].sessionFile;
  const sessionFile = path.isAbsolute(sf) ? sf : path.join(__dirname, sf);
  const headless = (section.headless != null ? section.headless : office.headless) !== false;
  // 조회 API 호스트: manager-office[-stage] → manager-office-api[-stage]
  let apiBase;
  try { apiBase = new URL(baseUrl).origin.replace('manager-office', 'manager-office-api'); }
  catch { apiBase = baseUrl.replace('manager-office', 'manager-office-api'); }
  return { env, baseUrl, apiBase, sessionFile, headless };
}

// 기본 export = stage(하위호환: 기존 CFG.baseUrl/sessionFile/headless 사용처 유지) + envConfig 함수
module.exports = Object.assign({ envConfig }, envConfig('stage'));
