'use strict';
/**
 * AI 비전 추천 (무의존성, 내장 fetch로 Anthropic Messages API 직접 호출)
 * -----------------------------------------------------------------------------
 * 후보 이미지들의 썸네일(base64)과 콘텐츠 주제·본문을 Claude 비전 모델에 보내
 * "이 콘텐츠에 가장 어울리는 이미지"를 순위와 짧은 이유로 반환한다.
 *
 * ⛔ NAS 원칙과 별개: 여기서는 이미지를 "읽어" 모델에 보낼 뿐, NAS를 수정하지 않는다.
 * 이미지 바이트는 호출측(server.js)이 Thumb API로 받아 base64로 넘겨준다.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// media_type 추론
function mediaType(name = '') {
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1]?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg'; // jpg/jpeg/기타 기본
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey            Anthropic API 키
 * @param {string} [opts.model]           모델 ID (기본 claude-opus-5)
 * @param {string} opts.hotel             호텔명
 * @param {string} opts.theme             콘텐츠 주제/제목
 * @param {string} [opts.body]            콘텐츠 본문
 * @param {Array<{name,path,base64}>} opts.candidates  후보 썸네일(base64, no prefix)
 * @param {number} [opts.topN]            추천 개수(기본 8)
 * @returns {Promise<{ranked:Array<{path,name,score,reason}>, note?:string}>}
 */
async function recommend({ apiKey, model, hotel, theme, body, candidates, topN = 8 }) {
  if (!apiKey) throw new Error('Anthropic API 키가 없습니다. ai.config.json 또는 nas.config.json 에 apiKey를 넣어주세요.');
  if (!candidates || !candidates.length) return { ranked: [] };

  const useModel = model || 'claude-opus-5';

  // 후보 이미지 블록 구성 — 각 이미지 앞에 인덱스 라벨 텍스트를 둔다.
  const content = [];
  content.push({
    type: 'text',
    text:
      `아래는 "${hotel}" 호텔의 실제 사진 후보들입니다. ` +
      `이 콘텐츠에 가장 어울리는 이미지를 골라 순위를 매겨 주세요.\n\n` +
      `[콘텐츠 주제] ${theme || '(미지정)'}\n` +
      `[콘텐츠 본문] ${(body || '').slice(0, 1200) || '(미지정)'}\n\n` +
      `후보 이미지는 [i=0], [i=1] ... 순서로 제시됩니다.`,
  });
  candidates.forEach((c, i) => {
    content.push({ type: 'text', text: `[i=${i}] 파일명: ${c.name}` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaType(c.name), data: c.base64 },
    });
  });
  content.push({
    type: 'text',
    text:
      `위 후보 중 콘텐츠에 어울리는 상위 ${topN}개를 골라 주세요. ` +
      `장면·분위기·소재(수영장/오션뷰/객실/조식/라운지/야경 등)가 콘텐츠 주제·본문과 맞는지를 기준으로 판단합니다.\n` +
      `반드시 아래 JSON만 출력하세요(설명·코드펜스 금지):\n` +
      `{"ranked":[{"i":정수,"score":0~100,"reason":"한국어 20자 내외 근거"}, ...]}`,
  });

  const reqBody = {
    model: useModel,
    max_tokens: 1500,
    thinking: { type: 'disabled' }, // 단순 랭킹 — 사고 토큰 절약(opus-5는 effort high 이하에서 허용)
    messages: [{ role: 'user', content }],
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(reqBody),
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = data && data.error && data.error.message;
    throw new Error(`Anthropic API 오류 ${res.status}: ${msg || JSON.stringify(data).slice(0, 300)}`);
  }
  if (data.stop_reason === 'refusal') {
    return { ranked: [], note: '모델이 요청을 거부했습니다(refusal).' };
  }

  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.ranked)) {
    return { ranked: [], note: '모델 응답을 파싱하지 못했습니다.', raw: text.slice(0, 400) };
  }

  const ranked = parsed.ranked
    .filter((r) => Number.isInteger(r.i) && candidates[r.i])
    .map((r) => ({
      path: candidates[r.i].path,
      name: candidates[r.i].name,
      score: clamp(r.score),
      reason: String(r.reason || '').slice(0, 60),
    }));

  return { ranked };
}

function clamp(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// 코드펜스/잡텍스트가 섞여도 첫 JSON 객체를 추출
function extractJson(text) {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

module.exports = { recommend };
