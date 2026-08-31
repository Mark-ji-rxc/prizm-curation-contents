'use strict';
// PRIZM 피드 카드 미리보기 3종 렌더러 (전역 window.renderPrizmPreviews)
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const specHtml = (text, spec) => { let h = esc(text || ''); (spec || []).forEach((s) => { const e = esc(String(s || '').trim()); if (e && h.includes(e)) h = h.split(e).join('<span class="spec-txt">' + e + '</span>'); }); return h; };
  const won = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('ko-KR') + '원');
  const thumb = (nasPath) => `/api/thumb?path=${encodeURIComponent(nasPath)}&size=large&`;
  const keyOf = (m) => String(m.productCode || m.productId || m.productName || '');

  function head(content) {
    const persona = content.persona || '호캉스 러버 MD';
    const hotels = (content.hotels && content.hotels.length) ? content.hotels : [...new Set((content.matched || []).map((m) => m.hotel).filter(Boolean))];
    const hotelLabel = hotels.length ? esc(hotels[0]) + (hotels.length > 1 ? ` 외 ${hotels.length - 1}개` : '') : '';
    const body = content.body || '';
    // 본문은 전체를 넣고 CSS로 8줄 클램프 → 초과 시 draw()에서 '더보기' 노출
    return `<div class="head"><div class="avatar"></div>
        <div class="head-t"><div class="who">${esc(persona)}${hotelLabel ? ' › ' + hotelLabel : ''}</div>
        <div class="ttl">${esc(content.title)}</div></div></div>
      <div class="desc-wrap"><div class="desc">${specHtml(body, content.speculative)}</div><span class="more" hidden>더보기</span></div>`;
  }
  // 상품 카드(상품코드/ID 미표기 — 요청 반영)
  function goodsChip(m, cls) {
    if (!m) return '';
    return `<div class="goods ${cls || ''}"><div class="gthumb"></div>
      <div><div class="ghotel">${esc(m.hotel || '')}</div><div class="gname">${esc(m.productName || m.name || '')}</div>
      <div class="gprice">${m.discount ? esc(m.discount) + '% ' : ''}${won(m.price)}</div></div></div>`;
  }

  function buildHtml(content, images, products, matches) {
    const H = head(content);
    // ① 이미지 + 상품 등록 — 이미지 3:4, 좌우 스와이프(전체 노출)
    const media = images.length
      ? images.map((im) => `<div class="ph"><img src="${thumb(im.nasPath)}" alt="" /></div>`).join('')
      : '<div class="ph empty"></div>';
    const card1 = `<div class="pv-wrap"><div class="pv-title">① 이미지 + 상품/쇼룸 등록 · 3:4 · 이미지 ${images.length}장(좌우 스와이프)</div>
      <div class="feed">${H}<div class="media portrait">${media}</div>${goodsChip(products[0])}</div></div>`;

    // ② 이미지 없이 상품만 등록 — 상품 캐러셀
    const gcards = (products.length ? products : [{}]).map((m) => `<div class="gcard">
        <div class="gimg"></div>
        <div class="gbody"><div class="ghotel">${esc(m.hotel || '')}</div><div class="gname">${esc(m.productName || m.name || '상품')}</div>
        <div class="gprice">${m.discount ? esc(m.discount) + '% ' : ''}${won(m.price)}</div></div></div>`).join('');
    const card2 = `<div class="pv-wrap"><div class="pv-title">② 이미지 없이 상품/쇼룸만 등록 · 상품/쇼룸 ${products.length}개</div>
      <div class="feed">${H}<div class="gcarousel">${gcards}</div></div></div>`;

    // ③ 이미지 + 상품 매칭 — 상품별 이미지 지정 + 매칭 슬라이드 스와이프
    const editor = products.map((m) => {
      const k = keyOf(m);
      const opts = images.map((im, j) => `<option value="${esc(im.nasPath)}" ${matches[k] === im.nasPath ? 'selected' : ''}>이미지 ${j + 1}${im.folder ? ' · ' + esc(im.folder) : ''}</option>`).join('');
      return `<div class="me-row"><span class="me-name">${esc(m.productName || m.name)}</span>
        <select class="me-sel" data-key="${esc(k)}" ${images.length ? '' : 'disabled'}>${opts || '<option>이미지 없음</option>'}</select></div>`;
    }).join('');
    const stages = products.map((m) => {
      const im = images.find((x) => x.nasPath === matches[keyOf(m)]) || images[0];
      const pic = im ? `<img src="${thumb(im.nasPath)}" alt="" />` : '<div class="stage-empty"></div>';
      return `<div class="stage">${pic}${goodsChip(m, 'overlay')}</div>`;
    }).join('');
    const card3 = `<div class="pv-wrap"><div class="pv-title">③ 이미지 + 상품/쇼룸 매칭 · 아이템별 이미지 지정(좌우 스와이프)</div>
      <div class="match-editor">${editor || '<div class="muted sm">선택된 상품/쇼룸이 없어요.</div>'}</div>
      <div class="feed">${H}<div class="stage-carousel">${stages}</div></div></div>`;

    return card1 + card2 + card3;
  }

  function renderPrizmPreviews(root, content, images, products, matches, onChange) {
    if (!content) { root.innerHTML = '<div class="muted">먼저 콘텐츠를 선택하고 이미지를 컨펌하세요.</div>'; return; }
    images = images || [];
    products = (products && products.length) ? products : (content.matched || []);
    matches = Object.assign({}, matches || {});
    // 매칭이 없는 상품은 순서대로 이미지 자동 배정(product i ↔ image i)
    products.forEach((m, i) => { const k = keyOf(m); if (!matches[k] && images.length) matches[k] = images[i % images.length].nasPath; });

    const draw = () => {
      root.innerHTML = buildHtml(content, images, products, matches);
      // 본문 8줄 초과 시에만 '더보기' 노출(초과 안 하면 그대로 전체 표시)
      root.querySelectorAll('.desc').forEach((el) => {
        if (el.scrollHeight > el.clientHeight + 2) { const more = el.parentElement.querySelector('.more'); if (more) more.hidden = false; }
      });
      root.querySelectorAll('.me-sel').forEach((sel) => sel.onchange = () => {
        matches[sel.dataset.key] = sel.value;
        if (onChange) onChange(Object.assign({}, matches));
        draw();
      });
    };
    draw();
    if (onChange) onChange(Object.assign({}, matches)); // 자동 배정 결과 저장
  }

  window.renderPrizmPreviews = renderPrizmPreviews;
})();
