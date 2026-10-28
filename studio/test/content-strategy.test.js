const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {harness}=require('./harness');
const {prepare}=require('../content-strategy');
test('manual keeps selected creative settings while auto clears only creative settings',()=>{
 const x={mode:'generate',generationStrategy:'manual',scope:'overseas',region:'일본',productCodes:['code-201'],hotels:['일본A'],productTypes:['해외 패키지'],bodyMin:700,bodyMax:1100,topic:'나의 주제',forms:['정보형'],persona:'화자',editEnabled:true};
 const m=prepare(x);assert.equal(m.bodyMin,700);assert.equal(m.topic,'나의 주제');
 const a=prepare({...x,generationStrategy:'auto'});assert.equal(a.bodyMin,300);assert.equal(a.bodyMax,600);assert.equal(a.topic,'');assert.deepEqual(a.forms,[]);assert.equal(a.perTopic,1);
 for(const k of ['region','productCodes','hotels','productTypes','editEnabled'])assert.deepEqual(a[k],x[k]);assert.equal(x.bodyMin,700);
});
for(const generationStrategy of ['auto','manual']){
 test(generationStrategy+' respects all range filters including direct selection intersection',async t=>{
  const h=harness(t);let r=await h.request('/api/content/generate',{provider:'both',generationStrategy,scope:'domestic',region:'부산',condition:'always',productTypes:['프리미엄 호텔'],hotels:['부산A'],productCodes:['code-101','code-102','code-201'],count:1,bodyMin:700,bodyMax:1100,topic:'테스트'});
  assert.equal(r.status,200);
  for(const run of r.body.jobs){const j=h.jobs.readJob(run.jobId);assert.deepEqual(j.products.map(p=>p.productId),['101']);assert.equal(j.input.bodyMin,generationStrategy==='auto'?300:700);assert.equal(j.input.generationStrategy,generationStrategy);if(generationStrategy==='auto'){assert.match(j.instructions,/14~19/);assert.match(j.instructions,/139/);assert.match(j.instructions,/인과/);}}
  r=await h.request('/api/content/generate',{provider:'codex',generationStrategy,scope:'domestic',region:'부산',productCodes:['code-201'],count:1});assert.equal(r.status,400);
 });
}
test('auto plan/write retains strategy, length and selected pool',async t=>{
 const h=harness(t);const r=await h.request('/api/content/generate',{provider:'codex',generationStrategy:'auto',scope:'overseas',region:'일본',productCodes:['code-201'],count:6,bodyMin:20,bodyMax:30});
 const j=h.jobs.readJob(r.body.jobId);assert.equal(j.input.bodyMax,600);assert.equal(j.input.phase,'plan');j.status='done';j.output={topics:[{topic:'또래 일본',angle:'편한 이동',form:'정보',productIds:['201']}]};fs.writeFileSync(h.jobs.jobPath(j.id),JSON.stringify(j));h.call('fanOutPlan',j.id);
 for(const id of h.jobs.readJob(j.id).output.shardJobs){const k=h.jobs.readJob(id);assert.equal(k.input.generationStrategy,'auto');assert.equal(k.input.bodyMax,600);assert.deepEqual(k.products.map(x=>x.productId),['201']);}
});
test('legacy brief and matching keep original semantics',()=>{
 assert.deepEqual(prepare({mode:'brief',bodyMin:700}),{mode:'brief',bodyMin:700});assert.deepEqual(prepare({mode:'match'}),{mode:'match'});
});
test('auto leaves an activity-only or a single-hotel pool intact rather than substituting packages',t=>{
 const h=harness(t);const j=h.call('buildContentJob',{provider:'codex',generationStrategy:'auto',scope:'domestic',region:'부산',hotels:['부산A'],count:1});
 assert.deepEqual(JSON.parse(JSON.stringify(j.products.map(p=>p.productId))),['101']);assert.match(j.instructions,/가짜 호텔/);assert.match(j.instructions,/추정하지 않는다/);
});
