const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const dates=require('../public/sale-date'),{harness}=require('./harness');
test('sale dates accept typed formats and normalize without timezone shifts',()=>{
 for(const v of ['2026-11-15','2026/11/15','2026.11.15','20261115'])assert.equal(dates.normalize(v),'2026-11-15');
 assert.equal(dates.normalize('2028-2-29'),'2028-02-29');
});
test('empty, partial and nonexistent dates cannot activate until filter',()=>{
 for(const v of ['','2026-','2026-02-29','2026-04-31','2026-13-01','2026-11-00','0010-01-01'])assert.equal(dates.ready('until',v),false);
 assert.equal(dates.ready('selling',''),true);
});
test('manual typing recovers empty date after picker attempt and refreshes all dependent filters',()=>{
 const nodes={cCondition:{value:'until'},cUntil:{value:''},cUntilText:{value:'',focus(){this.focused=true;}},cUntilNote:{textContent:''}};
 const calls=[];const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
 const start=source.indexOf('function saleDateReady()'),end=source.indexOf("$('#cUntil').addEventListener",start);
 const c=vm.createContext({SaleDate:dates,$:id=>nodes[id.slice(1)],refreshTypeCounts:()=>calls.push('types'),loadHotels:()=>calls.push('hotels'),refreshPickerIfOpen:()=>calls.push('picker')});
 vm.runInContext(source.slice(start,end),c);vm.runInContext('requestSaleDate()',c);assert.equal(nodes.cUntilText.focused,true);assert.equal(nodes.cUntil.value,'');
 nodes.cUntilText.value='20261115';c.event={target:{id:'cUntilText',value:'20261115'}};vm.runInContext('saleDateChanged(event)',c);
 assert.equal(nodes.cUntil.value,'2026-11-15');assert.deepEqual(calls,['types','hotels','picker']);
 nodes.cUntilText.value='2026-';c.event.target.value='2026-';vm.runInContext('saleDateChanged(event)',c);assert.equal(nodes.cUntil.value,'');assert.equal(vm.runInContext('saleDateReady()',c),false);
});
for(const strategy of ['auto','manual'])test(strategy+' missing until date is rejected before creating a generation job',async t=>{
 const h=harness(t);const r=await h.request('/api/content/generate',{provider:'both',generationStrategy:strategy,scope:'overseas',condition:'until',until:'',count:1});
 assert.equal(r.status,400);assert.match(r.body.error,/기준일/);assert.equal(h.jobs.listJobs().length,0);
});
