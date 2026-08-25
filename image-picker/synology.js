'use strict';
/**
 * Synology FileStation API 클라이언트 (무의존성, 내장 fetch 사용)
 * -----------------------------------------------------------------------------
 * - 로그인(SID) 유지 및 만료 시 자동 재로그인
 * - 공유폴더/폴더 목록, 재귀 검색
 * - 호텔명 → "저해상" 이미지 폴더 자동 해석 (경로 캐시)
 * - 썸네일(Thumb) / 원본(Download) 바이너리 프록시
 *
 * FileStation 문서 기준 엔드포인트는 모두 /webapi/entry.cgi 로 통일.
 *
 * ⛔ 읽기 전용(READ-ONLY) 원칙 — 절대 위반 금지
 *   이 클라이언트는 NAS에서 "조회"만 수행한다. 파일 생성/삭제/이름변경/이동/복사/
 *   업로드/편집 등 어떤 쓰기·수정 API도 구현하지 않는다.
 *   허용 메서드: list_share, list, search(start/list/stop/clean=검색태스크 정리, 파일 미변경),
 *               Thumb.get, Download.download 뿐이다.
 *   SYNO.FileStation.{CreateFolder,Delete,Rename,CopyMove,Upload,Edit} 등은 사용 금지.
 */

const fs = require('fs');
const path = require('path');

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'tif', 'webp', 'heic'];
const IMAGE_EXT_SET = new Set(IMAGE_EXTS);

// ── 문자열 정규화(퍼지 매칭용) ────────────────────────────────────────────────
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s_\-·・.,()\[\]{}&'"~!@#%]/g, '') // 공백·구분자 제거
    .replace(/호텔|resort|리조트|hotel|서울|the|더/g, ''); // 흔한 노이즈 토큰 완화
}
function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}
function isImage(name) {
  return IMAGE_EXT_SET.has(extOf(name));
}

class Synology {
  /**
   * @param {{host:string, port?:number, user:string, password:string,
   *          https?:boolean, verifyTls?:boolean, otp?:string}} cfg
   */
  constructor(cfg) {
    this.cfg = cfg;
    const scheme = cfg.https ? 'https' : 'http';
    const port = cfg.port || (cfg.https ? 5001 : 5000);
    this.base = `${scheme}://${cfg.host}:${port}/webapi`;
    this.sid = null;
    this._loginPromise = null;
    // TLS 검증 우회(사설 인증서 NAS) — verifyTls:false 일 때만
    if (cfg.https && cfg.verifyTls === false) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
    // 호텔명 → 경로 캐시(디스크)
    this.mapFile = path.join(__dirname, 'hotel-folder-map.json');
    this.folderMap = this._loadMap();
  }

  _loadMap() {
    try {
      return JSON.parse(fs.readFileSync(this.mapFile, 'utf8'));
    } catch {
      return {};
    }
  }
  _saveMap() {
    try {
      fs.writeFileSync(this.mapFile, JSON.stringify(this.folderMap, null, 2));
    } catch (e) {
      console.error('[syno] 폴더맵 저장 실패:', e.message);
    }
  }

  // ── 저수준 요청 ────────────────────────────────────────────────────────────
  _url(api, version, method, params = {}) {
    const u = new URL(`${this.base}/entry.cgi`);
    u.searchParams.set('api', api);
    u.searchParams.set('version', String(version));
    u.searchParams.set('method', method);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    if (this.sid) u.searchParams.set('_sid', this.sid);
    return u;
  }

  async _json(api, version, method, params = {}, { retry = true } = {}) {
    await this.ensureLogin();
    const u = this._url(api, version, method, params);
    const res = await fetch(u, { method: 'GET' });
    const data = await res.json();
    if (data && data.success) return data.data;
    const code = data && data.error && data.error.code;
    // SID 만료/무효 → 1회 재로그인 후 재시도
    if (retry && (code === 105 || code === 106 || code === 107 || code === 119)) {
      this.sid = null;
      await this.ensureLogin(true);
      return this._json(api, version, method, params, { retry: false });
    }
    const err = new Error(`Synology API 실패 ${api}.${method} code=${code}`);
    err.code = code;
    throw err;
  }

  // 바이너리(썸네일/다운로드) — Response 그대로 반환
  async _binary(api, version, method, params = {}, { retry = true } = {}) {
    await this.ensureLogin();
    const u = this._url(api, version, method, params);
    const res = await fetch(u, { method: 'GET' });
    const ct = res.headers.get('content-type') || '';
    // 에러는 JSON으로 떨어짐 → 재로그인 처리
    if (ct.includes('application/json')) {
      const data = await res.json();
      const code = data && data.error && data.error.code;
      if (retry && (code === 105 || code === 106 || code === 107 || code === 119)) {
        this.sid = null;
        await this.ensureLogin(true);
        return this._binary(api, version, method, params, { retry: false });
      }
      const err = new Error(`Synology 바이너리 실패 ${api}.${method} code=${code}`);
      err.code = code;
      throw err;
    }
    return res;
  }

  // ── 인증 ──────────────────────────────────────────────────────────────────
  async ensureLogin(force = false) {
    if (this.sid && !force) return;
    if (this._loginPromise) return this._loginPromise;
    this._loginPromise = (async () => {
      const u = new URL(`${this.base}/entry.cgi`);
      u.searchParams.set('api', 'SYNO.API.Auth');
      u.searchParams.set('version', '6');
      u.searchParams.set('method', 'login');
      u.searchParams.set('account', this.cfg.user);
      u.searchParams.set('passwd', this.cfg.password);
      u.searchParams.set('session', 'FileStation');
      u.searchParams.set('format', 'sid');
      if (this.cfg.otp) u.searchParams.set('otp_code', this.cfg.otp);
      const res = await fetch(u, { method: 'GET' });
      const data = await res.json();
      if (!data.success) {
        const code = data.error && data.error.code;
        throw new Error(
          `NAS 로그인 실패 (code=${code}). ${code === 400 ? '계정/비밀번호 확인' : code === 403 || code === 404 ? '2단계 인증(OTP) 필요할 수 있음' : ''}`
        );
      }
      this.sid = data.data.sid;
    })();
    try {
      await this._loginPromise;
    } finally {
      this._loginPromise = null;
    }
  }

  // ── 목록/검색 ──────────────────────────────────────────────────────────────
  async listShares() {
    const d = await this._json('SYNO.FileStation.List', 2, 'list_share', {
      additional: ['perm'],
    });
    return d.shares || [];
  }

  /** 폴더 하위 항목 (dir | file | all) */
  async list(folderPath, { onlyDirs = false, withTime = true } = {}) {
    const d = await this._json('SYNO.FileStation.List', 2, 'list', {
      folder_path: folderPath,
      filetype: onlyDirs ? 'dir' : 'all',
      additional: withTime ? ['size', 'time'] : ['size'],
      limit: 5000,
    });
    return d.files || [];
  }

  /** 재귀 검색(이미지 확장자 필터) — 폴백용 */
  async searchImages(folderPath, { pattern = '', limit = 1000 } = {}) {
    const start = await this._json('SYNO.FileStation.Search', 2, 'start', {
      folder_path: folderPath,
      recursive: true,
      filetype: 'file',
      extension: IMAGE_EXTS.join(','),
      pattern: pattern || undefined,
    });
    const taskid = start.taskid;
    // 검색이 끝날 때까지 잠깐 폴링
    let files = [];
    let finished = false;
    for (let i = 0; i < 20 && !finished; i++) {
      const r = await this._json('SYNO.FileStation.Search', 2, 'list', {
        taskid,
        additional: ['size', 'time'],
        limit,
        offset: 0,
      });
      files = r.files || [];
      finished = r.finished;
      if (!finished) await new Promise((res) => setTimeout(res, 400));
    }
    await this._json('SYNO.FileStation.Search', 2, 'stop', { taskid }).catch(() => {});
    await this._json('SYNO.FileStation.Search', 2, 'clean', { taskid }).catch(() => {});
    return files.filter((f) => isImage(f.name));
  }

  // ── 호텔 폴더 → 저해상 폴더 해석 ──────────────────────────────────────────────
  /**
   * 후보 폴더에서 정규식으로 자식 폴더를 고른다. 여러 후보면 이미지 폴더 흐름에
   * 가장 근접한 이름 우선.
   */
  async _pickChildDir(folderPath, regexes) {
    const dirs = (await this.list(folderPath, { onlyDirs: true })).filter((f) => f.isdir);
    for (const re of regexes) {
      const hit = dirs.find((d) => re.test(d.name));
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 호텔명 후보 폴더 수집 + 점수화(퍼지).
   * 공유폴더부터 maxDepth까지 BFS로 폴더명을 모아 scoreMatch로 정렬한다.
   * 실제 구조는 `공유폴더/…/00_콘텐츠/<호텔명>/01_포토&비디오/…` 처럼 호텔 폴더가
   * 깊은 곳(보통 depth 3)에 있으므로 얕게만 보면 못 찾는다 → 깊이 탐색.
   * 폴더명이 호텔명과 완벽히 같지 않아도(부분일치·약어·영문·군더더기) 잘 잡히도록 설계.
   */
  async collectRootCandidates(hotelName, { maxDepth = 3, listCap = 250 } = {}) {
    const cands = [];
    const shares = await this.listShares();
    const queue = [];
    for (const s of shares) {
      cands.push({ name: s.name, path: s.path, depth: 0, parent: null });
      queue.push({ path: s.path, depth: 0, parent: s.name });
    }
    let lists = 0;
    while (queue.length && lists < listCap) {
      const { path: p, depth, parent } = queue.shift();
      if (depth >= maxDepth) continue;
      let children;
      try {
        children = await this.list(p, { onlyDirs: true });
        lists++;
      } catch {
        continue;
      }
      for (const c of children) {
        if (!c.isdir) continue;
        if (/^[#.@$]/.test(c.name) || /recycle|appledb|@eaDir/i.test(c.name)) continue; // 시스템/휴지통 제외
        cands.push({ name: c.name, path: c.path, depth: depth + 1, parent });
        queue.push({ path: c.path, depth: depth + 1, parent: c.name });
      }
    }
    // 점수화 + 부모폴더 힌트 보정(콘텐츠 폴더 우대 / 쇼룸·디자인 등 감점)
    for (const c of cands) {
      let sc = scoreMatch(hotelName, c.name);
      const par = (c.parent || '').toLowerCase();
      if (/콘텐츠|contents|content|호텔|hotel/.test(par)) sc += 0.06;
      if (/쇼룸|svg|디자인|명함|로고|logo|backup|숏폼|라이브|아카이브|템플릿|에셋/.test(par)) sc -= 0.15;
      c.score = Math.max(0, Math.min(1, sc));
    }
    cands.sort((a, b) => b.score - a.score);
    return cands;
  }

  /**
   * 호텔 폴더에서 이미지 루트까지 내려간다.
   * 실제 구조 예: 호텔/01_포토&비디오/02_이미지/작업완료/{25년 고해상}/저해상_1280x720/{카테고리}/*.jpg
   * 고정 단계(포토→이미지→작업완료)를 최대한 따라간 뒤, 그 아래에서 "저해상" 폴더를
   * 재귀로 탐색한다. 못 찾으면 현재 위치를 이미지 루트로 삼아 하위 전체를 취합한다.
   * (이미지는 server가 listImagesRecursive로 카테고리 폴더까지 훑어 모은다.)
   */
  async walkToImageDir(rootPath) {
    const steps = [{ label: '호텔 폴더', path: rootPath, name: path.basename(rootPath) }];
    let cur = rootPath;

    // 각 단계: 구체적 이름을 먼저 시도(우선순위), 숫자접두사는 폴백.
    // 이미지 단계는 '비디오'를 배제(01_포토&비디오 아래 02_이미지/02_비디오 공존 주의).
    const stages = [
      { name: '포토&비디오', regexes: [/포토|photo|사진/i, /^01[_\s]/i, /비디오|video/i] },
      { name: '이미지/포토', regexes: [/이미지|image|img/i, /^01[_\s]?포토|포토|photo/i, /^02[_\s](?!.*(비디오|video))/i] },
      { name: '작업완료', regexes: [/작업\s?완료|완료|final|done|편집|retouch|보정/i] },
    ];
    for (const stage of stages) {
      const picked = await this._pickChildDir(cur, stage.regexes);
      if (picked) {
        cur = picked.path;
        steps.push({ label: stage.name, path: picked.path, name: picked.name });
      } else {
        break; // 못 찾으면 현재 위치를 앵커로 삼고 아래에서 저해상 탐색
      }
    }

    // 앵커 아래에서 "저해상"류 폴더 재귀 탐색
    const low = await this._findLowResDir(cur, 5);
    let usedFallback = false;
    if (low) {
      cur = low.path;
      steps.push({ label: '저해상', path: low.path, name: low.name });
    } else {
      // 저해상 폴더가 없으면 앵커 하위 전체를 취합(고해상 포함). 그래도 이미지가 없으면 이미지 최다 폴더로.
      usedFallback = true;
      const has = await this._hasImagesRecursive(cur, 4);
      if (!has) {
        const deeper = await this._deepestImageDir(rootPath, 5);
        if (deeper) {
          cur = deeper;
          steps.push({ label: '이미지 폴더(검색)', path: cur, name: path.basename(cur) });
        }
      } else {
        steps.push({ label: '이미지(전체 취합)', path: cur, name: path.basename(cur) });
      }
    }
    return { imageDir: cur, steps, usedFallback };
  }

  /** 앵커 아래에서 저해상/저용량/웹용/1280 등 이름의 폴더를 BFS로 찾음(가장 얕은 것 우선). */
  async _findLowResDir(startPath, maxDepth = 5) {
    const re = /저\s?해상|저해상도|저용량|웹용|웹\b|web|low\s?res|lowres|\blow\b|small|1280|1920|1024|960|압축|thumb|썸네일/i;
    const badRe = /사용\s?x|사용안함|미사용|안씀|쓰지|do\s?not|deprecated|old|구버전|이전버전|원본|raw|backup|복제|test|임시/i;
    const skipRe = /^[#.@$]|@eaDir|recycle/i;
    const queue = [{ p: startPath, d: 0 }];
    const hits = [];
    let visited = 0;
    while (queue.length && visited < 120) {
      const { p, d } = queue.shift();
      visited++;
      let files;
      try { files = await this.list(p, { onlyDirs: true }); } catch { continue; }
      for (const f of files) {
        if (!f.isdir || skipRe.test(f.name)) continue;
        if (re.test(f.name)) hits.push({ path: f.path, name: f.name, depth: d + 1, bad: badRe.test(f.name) ? 1 : 0 });
        if (d < maxDepth) queue.push({ p: f.path, d: d + 1 });
      }
    }
    if (!hits.length) return null;
    // 후보 중 '사용x/미사용/원본' 아닌 것 우선. 그중 카테고리(하위폴더)가 많은
    // '대표 저해상' 폴더를 우선(드론 저해상처럼 좁은 폴더 회피). 없으면 얕은 것.
    const clean = hits.filter((h) => !h.bad);
    const pool = clean.length ? clean : hits;
    pool.sort((a, b) => a.depth - b.depth);
    for (const h of pool.slice(0, 6)) {
      try {
        const kids = await this.list(h.path, { onlyDirs: true });
        h.childDirs = kids.filter((k) => k.isdir).length;
      } catch {
        h.childDirs = 0;
      }
    }
    const withKids = pool.filter((h) => (h.childDirs || 0) >= 2);
    if (withKids.length) {
      withKids.sort((a, b) => b.childDirs - a.childDirs || a.depth - b.depth);
      return withKids[0];
    }
    // 카테고리 있는 대표 저해상이 없으면 → 상위에서 전체 취합하도록 null 반환
    return null;
  }

  /** 하위(재귀)에 이미지가 하나라도 있는지 */
  async _hasImagesRecursive(startPath, maxDepth = 4) {
    const queue = [{ p: startPath, d: 0 }];
    let visited = 0;
    while (queue.length && visited < 120) {
      const { p, d } = queue.shift();
      visited++;
      let files;
      try { files = await this.list(p); } catch { continue; }
      for (const f of files) {
        if (!f.isdir && isImage(f.name)) return true;
        if (f.isdir && d < maxDepth) queue.push({ p: f.path, d: d + 1 });
      }
    }
    return false;
  }

  /**
   * 호텔명 → 저해상 이미지 폴더 경로 해석.
   * @param {object} [opts]
   * @param {boolean} [opts.useCache=true]
   * @param {string}  [opts.root]  이 폴더를 루트로 강제(수동 선택 시). 지정하면 퍼지매칭 생략.
   * @returns {{hotel, root, rootName, imageDir, steps, usedFallback, confident, candidates}}
   */
  async resolveHotelImageDir(hotelName, { useCache = true, root = null } = {}) {
    // 수동 지정 루트
    if (root) {
      const walked = await this.walkToImageDir(root);
      const result = {
        hotel: hotelName,
        root,
        rootName: path.basename(root),
        confident: true,
        manual: true,
        candidates: [],
        ...walked,
      };
      this.folderMap[hotelName] = {
        root,
        rootName: result.rootName,
        imageDir: result.imageDir,
        steps: result.steps,
        usedFallback: result.usedFallback,
        confident: true,
      };
      this._saveMap();
      return result;
    }

    if (useCache && this.folderMap[hotelName] && this.folderMap[hotelName].imageDir) {
      return { ...this.folderMap[hotelName], hotel: hotelName, cached: true, candidates: [] };
    }

    const candidates = await this.collectRootCandidates(hotelName);
    if (!candidates.length) {
      throw new Error(`'${hotelName}' 후보 폴더가 없습니다. NAS 공유폴더 접근 권한을 확인하세요.`);
    }
    const best = candidates[0];
    const confident = best.score >= 0.5;
    const walked = await this.walkToImageDir(best.path);

    const topCandidates = candidates.slice(0, 10).map((c) => ({
      name: c.name,
      path: c.path,
      score: round2(c.score),
      parent: c.parent,
    }));

    const result = {
      hotel: hotelName,
      root: best.path,
      rootName: best.name,
      score: round2(best.score),
      confident,
      candidates: topCandidates,
      ...walked,
    };
    this.folderMap[hotelName] = {
      root: best.path,
      rootName: best.name,
      imageDir: result.imageDir,
      steps: result.steps,
      usedFallback: result.usedFallback,
      confident,
    };
    this._saveMap();
    return result;
  }

  async _countImages(folderPath) {
    try {
      const files = await this.list(folderPath);
      return files.filter((f) => !f.isdir && isImage(f.name)).length;
    } catch {
      return 0;
    }
  }

  /** BFS로 이미지가 가장 많은 폴더를 찾음(깊이 제한) */
  async _deepestImageDir(startPath, maxDepth) {
    let best = null;
    let bestCount = 0;
    const queue = [{ p: startPath, d: 0 }];
    let visited = 0;
    while (queue.length && visited < 60) {
      const { p, d } = queue.shift();
      visited++;
      let files;
      try {
        files = await this.list(p);
      } catch {
        continue;
      }
      const count = files.filter((f) => !f.isdir && isImage(f.name)).length;
      if (count > bestCount) {
        bestCount = count;
        best = p;
      }
      if (d < maxDepth) {
        for (const f of files) if (f.isdir) queue.push({ p: f.path, d: d + 1 });
      }
    }
    return best;
  }

  /** 단일 폴더의 이미지 목록(비재귀) */
  async listImages(folderPath) {
    const files = await this.list(folderPath);
    return files
      .filter((f) => !f.isdir && isImage(f.name))
      .map((f) => ({
        name: f.name,
        path: f.path,
        folder: folderPath.split('/').pop(),
        size: f.additional && f.additional.size,
        mtime: f.additional && f.additional.time && f.additional.time.mtime,
      }));
  }

  /**
   * 이미지 루트 하위(재귀)의 이미지를 모두 모은다. 카테고리 폴더명(`folder`)을 함께 담아
   * 파일명이 무의미해도(예: _MG_6172.jpg) 키워드/추천에 쓸 수 있게 한다.
   * BFS라 얕은 폴더 이미지가 먼저 담긴다. cap으로 과다 수집 방지.
   */
  async listImagesRecursive(root, { maxDepth = 3, cap = 600 } = {}) {
    const out = [];
    const queue = [{ p: root, d: 0 }];
    let visited = 0;
    while (queue.length && out.length < cap && visited < 300) {
      const { p, d } = queue.shift();
      visited++;
      let files;
      try { files = await this.list(p); } catch { continue; }
      const folder = p.split('/').pop();
      for (const f of files) {
        if (f.isdir) {
          if (d < maxDepth && !/^[#.@$]|@eaDir/i.test(f.name)) queue.push({ p: f.path, d: d + 1 });
        } else if (isImage(f.name)) {
          out.push({
            name: f.name,
            path: f.path,
            folder,
            size: f.additional && f.additional.size,
            mtime: f.additional && f.additional.time && f.additional.time.mtime,
          });
          if (out.length >= cap) break;
        }
      }
    }
    return out;
  }

  // ── 바이너리 프록시 ────────────────────────────────────────────────────────
  /** 썸네일 Response (size: small|medium|large|original) */
  async thumb(filePath, size = 'small') {
    return this._binary('SYNO.FileStation.Thumb', 2, 'get', {
      path: filePath,
      size,
      rotate: 0,
    });
  }

  /** 원본 다운로드 Response */
  async download(filePath) {
    return this._binary('SYNO.FileStation.Download', 2, 'download', {
      path: filePath,
      mode: 'download',
    });
  }
}

// ── 유사도(정규화 문자열 기준) ─────────────────────────────────────────────────
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.9;
  // 문자 단위 자카드
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter++;
  const jac = inter / (sa.size + sb.size - inter);
  // 최장 공통 부분문자열 비중
  const lcs = longestCommonSubstr(a, b) / Math.max(a.length, b.length);
  return Math.max(jac * 0.6 + lcs * 0.6, 0);
}
function longestCommonSubstr(a, b) {
  const m = a.length, n = b.length;
  let max = 0;
  const dp = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev + 1;
        if (dp[j] > max) max = dp[j];
      } else dp[j] = 0;
      prev = tmp;
    }
  }
  return max;
}

// ── 강화된 폴더-호텔 매칭 ─────────────────────────────────────────────────────
// 완벽 일치가 아니어도(부분일치·약어·영문·군더더기 토큰) 폴더를 찾도록 점수화.
function normHard(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s_\-·・.,()\[\]{}&'"~!@#%|/\\+]+/g, '');
}
// 흔한 군더더기 토큰(브랜드·유형어) — 매칭 변별력이 낮아 제외
const NOISE_TOKENS = new Set([
  '호텔', 'hotel', '리조트', 'resort', 'the', '더', '스테이', 'stay', '펜션', 'pension',
  '풀빌라', '풀', '빌라', 'villa', '스파', 'spa', '레지던스', 'residence', '독채', '앤', 'and',
]);
function coreTokens(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[\s_\-·・.,()\[\]{}&'"~!@#%|/\\+]+/)
    .map((t) => t.trim())
    .filter((t) => t && !NOISE_TOKENS.has(t));
}
function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}
function bigramJaccard(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const sa = new Set(bigrams(a));
  const sb = new Set(bigrams(b));
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}
/** 호텔명 ↔ 폴더명 유사도(0~1). 여러 신호의 최댓값을 취해 관대하게 매칭. */
function scoreMatch(hotel, folder) {
  const h = normHard(hotel);
  const f = normHard(folder);
  if (!h || !f) return 0;
  if (h === f) return 1;
  let score = 0;
  // 포함관계(강한 신호)
  if (f.includes(h)) score = Math.max(score, 0.95);
  if (h.includes(f) && f.length >= 3) score = Math.max(score, 0.88);
  // 핵심 토큰 커버리지: 호텔명 핵심 토큰이 폴더명에 얼마나 들어있나
  const ht = coreTokens(hotel);
  if (ht.length) {
    let hit = 0;
    for (const t of ht) {
      const tn = normHard(t);
      if (tn && f.includes(tn)) hit++;
    }
    score = Math.max(score, (hit / ht.length) * 0.9);
  }
  // 최장 공통 부분문자열 비중
  const lcs = longestCommonSubstr(h, f) / Math.max(h.length, f.length);
  score = Math.max(score, lcs * 0.85);
  // 문자 bigram 자카드(오탈자·순서변화 흡수)
  score = Math.max(score, bigramJaccard(h, f) * 0.75);
  return score;
}
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

module.exports = { Synology, isImage, extOf, norm, similarity, scoreMatch, IMAGE_EXTS };
