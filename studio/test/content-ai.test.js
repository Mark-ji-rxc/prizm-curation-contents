'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const AI = require('../content-ai');
const ROOT = path.resolve(__dirname, '..');
const plain = (v) => JSON.parse(JSON.stringify(v));
const { harness } = require('./harness');
test('provider choices preserve legacy default and reject unsupported values',()=>{
  assert.deepEqual(AI.providers(),['claude']);assert.deepEqual(AI.providers('both'),['claude','codex']);assert.throws(()=>AI.providers('other'));
});
for (const provider of ['claude','codex']) {
  test(provider+': domestic + region + type + multi-hotel filters AND together',t=>{
    const h=harness(t);const j=h.call('buildContentJob',{provider,scope:'domestic',region:'부산',condition:'always',productTypes:['프리미엄 호텔'],hotels:['부산A','부산B'],count:2,bodyMin:400,bodyMax:650,forms:['④팁·정보형']});
    assert.deepEqual(plain(j.products.map(p=>p.productId)),['101','103']);assert.equal(j.input.bodyMin,400);assert.equal(j.input.bodyMax,650);assert.match(j.rules.본문,/400~650/);assert.equal(j.input.provider,provider);
  });
  test(provider+': explicit product selection retains priority over other filters',t=>{
    const h=harness(t);const j=h.call('buildContentJob',{provider,scope:'domestic',region:'부산',condition:'always',productCodes:['code-201'],hotels:['부산A'],count:1});
    assert.deepEqual(plain(j.products.map(p=>p.productId)),['201']);
  });
  test(provider+': brief keeps overseas scope, filters and independent custom length',t=>{
    const h=harness(t);const j=h.call('buildContentJob',{provider,mode:'brief',brief:'여행 이야기',scope:'overseas',region:'일본',hotels:['일본A'],productTypes:['해외 패키지'],count:1,bodyMin:700,bodyMax:1100});
    assert.deepEqual(plain(j.products.map(p=>p.productId)),['201']);assert.equal(j.input.bodyMin,700);assert.match(j.instructions,/700~1100/);assert.equal(j.input.brief,'여행 이야기');
  });
  test(provider+': upcoming/until sale conditions are unchanged',t=>{
    const h=harness(t);const j=h.call('buildContentJob',{provider,scope:'domestic',region:'부산',condition:'upcoming',count:1});assert.deepEqual(plain(j.products.map(p=>p.productId)),['104']);
    const k=h.call('buildContentJob',{provider,scope:'domestic',region:'부산',condition:'until',until:'2026-11-02',count:1});assert.deepEqual(plain(k.products.map(p=>p.productId)),['101','103','104']);
  });
}
test('both API launches independent jobs with identical content constraints and payload',async t=>{
  const h=harness(t);const r=await h.request('/api/content/generate',{provider:'both',scope:'domestic',region:'부산',count:2,perTopic:2,bodyMin:250,bodyMax:450,persona:'여행친구',forms:['④팁·정보형'],webSearch:true});
  assert.equal(r.status,200);assert.equal(r.body.jobs.length,2);
  const [a,b]=r.body.jobs.map(x=>h.jobs.readJob(x.jobId));assert.notEqual(a.id,b.id);assert.equal(a.input.provider,'claude');assert.equal(b.input.provider,'codex');
  const {provider:pa,...ia}=a.input,{provider:pb,...ib}=b.input;assert.deepEqual(ia,ib);assert.deepEqual(a.products,b.products);assert.deepEqual(a.rules,b.rules);assert.equal(a.instructions,b.instructions);assert.deepEqual(a.referenceExamples,b.referenceExamples);
});
test('invalid provider produces HTTP 400 without launching jobs',async t=>{const h=harness(t);const r=await h.request('/api/content/generate',{provider:'bad',scope:'domestic'});assert.equal(r.status,400);assert.equal(h.jobs.listJobs().length,0);});
test('empty range fails cleanly and does not leave pending jobs',async t=>{const h=harness(t);const r=await h.request('/api/content/generate',{provider:'both',scope:'domestic',region:'없는지역'});assert.equal(r.status,400);assert.ok(h.jobs.listJobs().every(j=>j.status==='failed'));});
test('both sharded plans keep provider + all range/length conditions in write jobs',async t=>{
  const h=harness(t);const r=await h.request('/api/content/generate',{provider:'both',scope:'domestic',region:'부산',hotels:['부산A'],count:6,bodyMin:600,bodyMax:900});
  for(const run of r.body.jobs){
    const j=h.jobs.readJob(run.jobId);assert.equal(j.input.phase,'plan');j.status='done';j.output={topics:Array.from({length:6},(_,i)=>({topic:'주제'+i,angle:'각도'+i,form:'정보',productIds:['101']}))};fs.writeFileSync(h.jobs.jobPath(j.id),JSON.stringify(j));
    h.call('fanOutPlan',j.id);const plan=h.jobs.readJob(j.id);assert.equal(plan.output.shardJobs.length,2);
    for(const id of plan.output.shardJobs){const kid=h.jobs.readJob(id);assert.equal(kid.input.provider,run.provider);assert.equal(kid.input.bodyMin,600);assert.deepEqual(kid.input.hotels,['부산A']);assert.deepEqual(kid.products.map(p=>p.productId),['101']);}
  }
});
test('result polling stamps provider including historic Claude jobs',async t=>{
 const h=harness(t);for(const provider of ['claude','codex']){const j=h.call('buildContentJob',{provider,scope:'domestic',count:1});j.status='done';j.output={items:[{title:'제목',body:'본문',matched:['101']}]};fs.writeFileSync(h.jobs.jobPath(j.id),JSON.stringify(j));const r=await h.request('/api/content/job?id='+j.id);assert.equal(r.body.items[0].generationProvider,provider);assert.equal(r.body.items[0].matched[0].productName,'부산A 상품');}
});
test('region mode keeps forced web search and its existing region product pool',t=>{const h=harness(t);const j=h.call('buildContentJob',{provider:'codex',scope:'domestic',region:'부산',regionMode:true,festival:true,webSearch:false,count:1});assert.equal(j.input.webSearch,true);assert.equal(j.input.festival,true);assert.ok(j.products.every(p=>p.region==='부산'));});
test('scheduled both keeps provider per job',t=>{const h=harness(t);h.call('createScheduledJob',{name:'테스트',params:{provider:'both',scope:'domestic',count:1}});assert.deepEqual(h.jobs.listJobs().map(j=>j.input.provider),['claude','codex']);assert.ok(h.jobs.listJobs().every(j=>j.scheduled));});
function sampleJob(){return {id:'sample',type:'content',status:'pending',input:{editEnabled:true,provider:'codex',count:1,perTopic:1,mode:'generate',bodyMin:20,bodyMax:80,webSearch:false},products:[{productId:'101',name:'검증 상품'}],instructions:'상품과 길이를 지켜요',rules:{},referenceExamples:[]};}
function sampleOutput(){return {items:[{title:'테스트 제목',body:'상품의 실제 혜택만 소개하는 테스트 콘텐츠예요.',form:'정보',persona:'',hotels:[],matched:['101'],region:'',speculative:[],titleAlternatives:[]}]};}
test('GPT output validation rejects out-of-scope products and body length drift',()=>{
 const j=sampleJob(),o=sampleOutput();assert.equal(AI.validateOutput(j,o),o);o.items[0].matched=['999'];assert.throws(()=>AI.validateOutput(j,o),/범위 밖/);o.items[0].matched=['101'];o.items[0].body='짧음';assert.throws(()=>AI.validateOutput(j,o),/글자|범위/);
});
test('matching does not rewrite user title/body',()=>{const j=sampleJob();j.input.mode='match';j.input.userContent={title:'내 제목',body:'내 원문'};const o=sampleOutput();assert.throws(()=>AI.validateOutput(j,o),/원본 글/);Object.assign(o.items[0],j.input.userContent);AI.validateOutput(j,o);});
test('runner uses read-only CLI, passes complete prompt, atomically saves output, no invented cost',async t=>{
 const h=harness(t);const j=h.jobs.createJob('content',sampleJob());let args,prompt='';let child;
 const runner=AI.createCodexRunner({dir:h.dir,jobs:h.jobs,onPlan(){},markFailed(){assert.fail('should succeed');},env:{AUTO_CODEX:'1',CODEX_BIN:'/fake/codex'},spawnProcess(bin,a,opts){
  args=a;assert.equal(bin,'/fake/codex');assert.ok(opts.cwd.startsWith(h.dir));child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
  child.stdin.on('data',d=>prompt+=d);child.stdin.on('finish',()=>{fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify(sampleOutput()));child.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:30,output_tokens:50}})+'\n');child.emit('close',0);});return child;
 }});
 runner(j.id);await new Promise(resolve=>setImmediate(resolve));const done=h.jobs.readJob(j.id);assert.equal(done.status,'done');assert.equal(done.usage.inputTokens,140);assert.equal(done.usage.costUsd,null);assert.equal(args[args.indexOf('--sandbox')+1],'read-only');assert.ok(args.includes('web_search="disabled"'));assert.ok(prompt.includes('검증 상품'));assert.equal(fs.existsSync(h.jobs.jobPath(j.id)+'.tmp'),false);
});
test('runner spawn/login failure settles job rather than spinning',async t=>{
 const h=harness(t);const j=h.jobs.createJob('content',sampleJob());let error;
 AI.createCodexRunner({dir:h.dir,jobs:h.jobs,onPlan(){},markFailed(id,msg){error=msg;},env:{},spawnProcess(){throw new Error('ENOENT');}})(j.id);assert.match(error,/GPT 실행 실패/);
});


test('edit choice persists through both-provider plans and write shards',async t=>{
 const h=harness(t);
 for(const editEnabled of [true,false]){
  const r=await h.request('/api/content/generate',{provider:'both',scope:'domestic',count:6,editEnabled});
  for(const run of r.body.jobs){
   const j=h.jobs.readJob(run.jobId);assert.equal(j.input.editEnabled,editEnabled);
   j.status='done';j.output={topics:[{topic:'주제',angle:'각도',form:'정보',productIds:['101']}]};fs.writeFileSync(h.jobs.jobPath(j.id),JSON.stringify(j));h.call('fanOutPlan',j.id);
   for(const id of h.jobs.readJob(j.id).output.shardJobs)assert.equal(h.jobs.readJob(id).input.editEnabled,editEnabled);
  }
 }
});
