const test=require('node:test'),assert=require('node:assert/strict');
const E=require('../gpt-editorial');
const AI=require('../content-ai');
const item={title:'초안',body:'확인되지 않은 듯해요.',matched:['1'],form:'형',persona:'화자',hotels:['호텔'],region:'부산',speculative:['확인되지 않은 듯해요.'],titleAlternatives:[]};
test('only content writing enters edit stage; plans and user matching skip',()=>{
 assert.equal(E.shouldEdit({input:{editEnabled:true,mode:'generate'}}),true);
 assert.equal(E.shouldEdit({input:{editEnabled:true,mode:'brief'}}),true);
 assert.equal(E.shouldEdit({input:{editEnabled:true,phase:'write'}}),true);
 assert.equal(E.shouldEdit({input:{editEnabled:true,phase:'plan'}}),false);
 assert.equal(E.shouldEdit({input:{editEnabled:true,mode:'match'}}),false);
});
test('editing retains original product and classification metadata',()=>{
 const draft={items:[item]},edited={items:[{...item,title:'개선된 제목',form:'다른형',hotels:['다른호텔']}]};
 const result=E.mergeEdited({},draft,edited);assert.equal(result.items[0].title,'개선된 제목');assert.equal(result.items[0].form,'형');assert.deepEqual(result.items[0].hotels,['호텔']);assert.equal(draft.items[0].title,'초안');
});
test('editing rejects product changes, emphasis markup and lost uncertainty',()=>{
 const draft={items:[item]};
 assert.throws(()=>E.mergeEdited({},draft,{items:[{...item,matched:['2']}]}),/상품/);
 assert.throws(()=>E.mergeEdited({},draft,{items:[{...item,body:'**강조**'}]}),/서식/);
 assert.throws(()=>E.mergeEdited({},draft,{items:[{...item,body:'확실해요.'}]}),/추측/);
});
test('both draft and final remain subject to user-selected length',()=>{
 const job={input:{editEnabled:true,mode:'generate',count:1,perTopic:1,bodyMin:20,bodyMax:40},products:[{productId:'1'}]};
 assert.throws(()=>AI.validateOutput(job,{items:[{...item,body:'짧음'}]}),/범위/);
 assert.throws(()=>AI.validateOutput(job,{items:[{...item,body:'가'.repeat(41)}]}),/범위/);
});

test('editing is opt-in, disabled and omitted requests skip editor',()=>{
 assert.equal(E.shouldEdit({input:{mode:'generate'}}),false);
 assert.equal(E.shouldEdit({input:{mode:'generate',editEnabled:false}}),false);
 assert.equal(E.shouldEdit({input:{mode:'brief',editEnabled:true}}),true);
});
