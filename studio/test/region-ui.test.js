'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {harness}=require('./harness');
const source=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
function runFunction(name,context){const start=source.indexOf('function '+name+'(');const end=source.indexOf('\n}',start)+2;vm.runInNewContext(source.slice(start,end)+'\n'+name+'();',context);}
function element(value=''){const classes=new Set();return {value,checked:false,disabled:false,classList:{toggle(k,on){on?classes.add(k):classes.delete(k);},contains:k=>classes.has(k)},closest(){return this;}};}
test('GPT hides Claude speed; Claude and both restore its selected value',()=>{
 const els={};const $=id=>els[id]||(els[id]=element());$('#cModel').value='sonnet';
 for(const provider of ['codex','claude','both','codex']){ $('#cProvider').value=provider;runFunction('updateProviderUI',{$,genMode:'generate'});assert.equal($('#claudeModelWrap').classList.contains('hidden'),provider==='codex');assert.equal($('#cModel').disabled,provider==='codex');assert.equal($('#cModel').value,'sonnet'); }
});
test('region auto remains selectable and keeps search locked; manual restores creative controls',()=>{
 const els={};const $=id=>els[id]||(els[id]=element());$('#cStrategy').value='auto';let region=true;
 const context={$,regionModeOn:()=>region};runFunction('updateGenerationStrategy',context);
 assert.equal($('#cStrategy').disabled,false);assert.equal($('#cWeb').disabled,true);assert.equal($('#cWeb').checked,true);assert.equal($('#cBodyLen').classList.contains('hidden'),true);assert.equal($('#autoStrategyNote').classList.contains('hidden'),false);
 $('#cStrategy').value='manual';runFunction('updateGenerationStrategy',context);assert.equal($('#cBodyLen').classList.contains('hidden'),false);region=false;$('#cStrategy').value='auto';runFunction('updateGenerationStrategy',context);assert.equal($('#cStrategy').disabled,false);assert.equal($('#cWeb').disabled,false);assert.equal($('#cBodyLen').classList.contains('hidden'),true);
});
for(const festival of [true,false])for(const generationStrategy of ['auto','manual'])test(generationStrategy+' region festival='+festival+' survives API for both providers',async t=>{
 const h=harness(t);const r=await h.request('/api/content/generate',{provider:'both',generationStrategy,scope:'domestic',region:'부산',regionMode:true,festival,webSearch:false,condition:'until',until:'',bodyMin:400,bodyMax:650,count:1});
 assert.equal(r.status,200);for(const run of r.body.jobs){const j=h.jobs.readJob(run.jobId);assert.equal(j.input.regionMode,true);assert.equal(j.input.festival,festival);assert.equal(j.input.webSearch,true);assert.equal(j.input.generationStrategy,generationStrategy);assert.equal(j.input.bodyMax,generationStrategy==='auto'?500:650);if(generationStrategy==='auto'){assert.match(j.instructions,/지역·축제 작성 전략/);assert.match(j.instructions,/14~19/);assert.doesNotMatch(j.instructions,/해외: 필터 안에서 항공/);}assert.ok(j.products.every(p=>p.region==='부산'));}
});
