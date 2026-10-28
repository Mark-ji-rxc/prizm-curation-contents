'use strict';
const editorial = require('./gpt-editorial');
const report = {
 file: '/Users/rxc/Desktop/claude code/funnel_report/reports/prizm_post_writing_2026-10-25.html',
 period: '2026-09-11~2026-10-25', sample: '국내83/해외43, 노출 유저150명 이상', version: '2026-10-28-v1',
};
function prepare(options) {
 const o={...options};
 if (o.mode && o.mode !== 'generate') return o;
 if (!o.generationStrategy) return o; // legacy jobs/briefs keep existing semantics
 if (!['auto','manual'].includes(o.generationStrategy)) throw new Error('생성 방식은 알아서 생성하기 또는 조건에 맞춰 생성하기를 선택해 주세요.');
 o.strictFilters=true;
 // Both new generation choices must keep the selected product pool, never region-only mode.
 o.regionMode=false;o.festival=false;
 if(o.generationStrategy==='auto') Object.assign(o,{
  topic:'',forms:[],form:'',persona:'',perTopic:1,
  bodyMin:300,bodyMax:o.scope==='overseas'?600:500,
 });
 return o;
}
const guide=`알아서 생성하기 — 리포트 기반 작성 전략
이 절은 자동 방식에만 적용한다. 기존의 본문 형/주제 방향/화자/글자수 설정 대신 input의 자동 정책을 따른다. 제목은 공백·이모지를 포함해 14~19자를 목표로 한다(다른 절의 8~16자 지시보다 이 기준이 우선). 본문은 input.bodyMin~bodyMax 범위 안에서 정보량에 맞춰 길이를 선택한다. 빈말로 하한을 채우지 않는다.
근거는 2026-09-11~10-25 관측 자료(국내83/해외43)다. 위치 보정 클릭 지수, 기여/어시스트는 인과효과나 순이익이 아니다. 더보기 수를 늘리는 미끼보다 상품 클릭과 합리적 선택을 돕는 글을 쓴다. 성과 수치나 과거 상품·가격을 현재 상품의 정보로 쓰지 않는다.
1. 제목과 본문 앞 약139자: 누구와/언제/지역/무슨 고민 중 근거 있는 2가지 이상과 구체적인 선택 이유를 제시한다. 첫 문단 1~2문장·약80자 이내. 장황한 공감으로 상품이 밀리지 않게 하고 가능하면 앞140자에 첫 항목이나 상품 효용을 드러낸다. 실제 화면 글자수는 기기마다 다르므로 근사 기준이다.
2. 본문: 짧은 문단(대략60~120자), 항목명과 설명을 분리. 고민→구성으로 해결, 인원/일정 조건별 추천, 취향별 비교, 검증된 시즌/숙소의 새로운 사실 중 상품에 맞는 각도를 골라 배치마다 다양화한다. 상품이 충분하고 실제로 비교할 근거가 있을 때만 2~5개 선택지를 쓴다. 상품1개면 그 상품의 실제 구성 항목으로 정리하며 가짜 호텔·선택지를 만들지 않는다.
3. 해외: 필터 안에서 항공·숙박 패키지와 대상별 효용을 우선 검토한다. 판매중인 프로모션/방송후라는 사실은 데이터에 명시된 경우에만 선호 근거로 사용한다. 일반 판매중/LIVE 이름만으로 프로모션 기간이나 방송 시각을 추정하지 않는다. 투어/액티비티만 선택됐으면 선택 범위를 바꾸지 말고 그 상품의 실제 가치로 쓴다. 가족·아이·4인·또래는 상품 조건에 근거가 있을 때만 사용한다.
4. 국내: 시즌·지역·숙소의 구체적 차별점을 판매상품과 연결한다. 서울/부산만 선택됐다고 소도시 상품으로 바꾸지 않는다. 시즌·축제·접근성·건축가·주변명소는 제공 데이터나 현재 검색 근거로 확인된 것만 쓰고 과거 리포트의10월 일정은 재사용하지 않는다.
5. 대표 상품: 글의 핵심 이점을 가장 잘 보여주는 실제 상품ID를 matched의 첫 번째에 둔다. 나머지도 글과 관련 있는 것만. 가격이 핵심 선택 근거일 때만 포함 범위/인원 기준과 함께 본문 중간에 사용한다. 할인율·혜택 나열로 시작하지 않는다. 값이0이거나 기준이 없으면 가격을 쓰지 않는다.
6. 반복 시리즈명/추상적인 분위기/셀럽·유행어 미끼/가짜 체험담/근거 없는 친목·시설·혜택을 피한다. 기존 사용자 수정 예시의 자연스러운 말투·문단·효용·마무리를 적용하되 모호한 불안 표현을 새로 만들지 않는다. 계절/날짜·포함조건을 왜곡하거나 필수 안내를 삭제하지 않는다.
7. 이모지는 의미 있는 항목에 절제해서 사용. Markdown 굵은 글씨/제목/HTML 대신 일반 텍스트와 줄바꿈. 클릭·매출 상승을 보장하는 문구 금지.
8. 피드 위치·발행 시점·첫 이미지와 상품의 실제 주문은 글만으로 결정되지 않는다. 게시글 작성만 수행하고 발행/미디어를 자동 변경하지 않는다.
`;
function instructions(o){return o.generationStrategy==='auto'?guide+'\n\n사용자 수정 사례에서 축적한 작성 스타일:\n'+editorial.guide:'';}
module.exports={prepare,instructions,report};
