(function(root){
 'use strict';
 function normalize(value){
  const text=String(value||'').trim();
  const m=/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(text)||/^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if(!m)return '';
  const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]);
  const date=new Date(Date.UTC(y,mo-1,d));
  if(y<1000||y>9999||date.getUTCFullYear()!==y||date.getUTCMonth()!==mo-1||date.getUTCDate()!==d)return '';
  return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
 }
 function ready(condition,value){return condition!=='until'||!!normalize(value);}
 const api={normalize,ready};
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.SaleDate=api;
})(typeof window==='object'?window:globalThis);
