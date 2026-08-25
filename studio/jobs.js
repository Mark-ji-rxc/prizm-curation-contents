'use strict';
/**
 * 파일 기반 job 핸드셰이크 큐 (무의존성)
 * -----------------------------------------------------------------------------
 * "지금 쓰는 이 Claude(Opus)"와 프로그램을 API 결제 없이 연동하는 장치.
 *   1) 프로그램이 jobs/<id>.json 을 status:"pending" 으로 생성(입력·규칙·데이터 포함).
 *   2) Claude Code 세션(사람이 채팅으로 트리거)이 그 파일을 Read → 결과를 채우고
 *      같은 파일에 status:"done", output:{...} 로 덮어써 저장.
 *   3) 프로그램 UI가 이 파일을 폴링해 결과를 화면에 바로 표시.
 * type: "content"(콘텐츠 생성) | "imagerec"(이미지 추천)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const JOBS_DIR = path.join(__dirname, 'jobs');

function ensure() { fs.mkdirSync(JOBS_DIR, { recursive: true }); }
function jobPath(id) { return path.join(JOBS_DIR, id + '.json'); }

function createJob(type, payload) {
  ensure();
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const id = `${type}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  const job = { id, type, status: 'pending', createdAt: new Date().toISOString(), ...payload };
  fs.writeFileSync(jobPath(id), JSON.stringify(job, null, 2));
  return job;
}

function readJob(id) {
  try { return JSON.parse(fs.readFileSync(jobPath(id), 'utf8')); } catch { return null; }
}

function listJobs(type) {
  ensure();
  return fs.readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith('.json') && (!type || f.startsWith(type + '-')))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

function pending(type) {
  return listJobs(type).filter((j) => j.status === 'pending').sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

module.exports = { JOBS_DIR, jobPath, createJob, readJob, listJobs, pending };
