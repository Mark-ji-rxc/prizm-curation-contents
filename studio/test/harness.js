const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm');
const {PassThrough}=require('stream');
const AI=require('../content-ai');
const ROOT=path.resolve(__dirname,'..');
function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prizm-ai-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jobDir = path.join(dir, 'jobs'); fs.mkdirSync(jobDir);
  let serial = 0, handler;
  const jobs = {
    jobPath: (id) => path.join(jobDir, id + '.json'),
    createJob(type, payload) { const j = { id: 'test-' + (++serial), type, status: 'pending', createdAt: new Date().toISOString(), ...payload }; fs.writeFileSync(this.jobPath(j.id), JSON.stringify(j)); return j; },
    readJob(id) { try { return JSON.parse(fs.readFileSync(this.jobPath(id))); } catch { return null; } },
    listJobs(type) { return fs.readdirSync(jobDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(jobDir, f)))).filter((j) => !type || j.type === type); },
  };
  const row = (id, source, region, hotel, productType, extra = {}) => ({ productId: id, productCode: 'code-' + id, source, region, hotel, productType, type: productType, name: hotel + ' 상품', status: '판매중', alwaysOn: true, price: 200000, flags: {}, ...extra });
  const rows = [
    row('101','domestic','부산','부산A','프리미엄 호텔'),
    row('102','domestic','서울','서울A','프리미엄 호텔'),
    row('103','domestic','부산','부산B','프리미엄 호텔'),
    row('104','domestic','부산','부산C','라이프스타일 호텔', { status:'판매예정', alwaysOn:false, saleStart:'2026-11-01' }),
    row('201','overseas','오사카 여행','일본A','해외 패키지'),
    row('202','overseas','푸꾸옥 여행','푸꾸옥A','해외 패키지'),
  ];
  const crawl = { normalizedItems:(scope)=>rows.filter((r)=>r.source===scope), datasetInfo:(scope)=>({ jsonFile:scope+'.json',updatedAt:'test' }) };
  const fakeProcess = { env:{ ...process.env, AUTO_CLAUDE:'0', AUTO_CODEX:'0' }, on(){}, exit(){ throw new Error('unexpected exit'); } };
  const context = vm.createContext({ __dirname:dir, Buffer, URL, console:{log(){},error(){}}, process:fakeProcess,
    setInterval:()=>({unref(){}}), clearInterval(){}, setTimeout:()=>({unref(){}}), clearTimeout(){}, setImmediate(){},
    require(name) {
      if(name==='./crawl') return crawl;
      if(name==='./jobs') return jobs;
      if(name==='./content-ai') return { ...AI, createCodexRunner: (opts) => AI.createCodexRunner({ ...opts, env:fakeProcess.env }) };
      if(name==='./content-strategy') return require('../content-strategy');
      if(name==='./overseas') return {};
      if(name.startsWith('../image-picker/')) return {};
      if(name==='http') return { createServer(fn) { handler=fn; return {on(){},listen(){}}; } };
      return require(name);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT,'server.js'),'utf8'),context);
  const call = (name,...args) => { context._args=args; return vm.runInContext(`${name}(..._args)`,context); };
  const request = async (url,body) => {
    const req = new PassThrough(); req.url=url;req.method=body===undefined?'GET':'POST';req.headers={host:'localhost'};
    let status; let result;
    const res = { writeHead(s){status=s;},end(s){result=s;},setHeader(){} };
    const done=handler(req,res);req.end(body===undefined?'':JSON.stringify(body));await done;
    return {status,body:JSON.parse(result)};
  };
  return {dir,jobs,rows,call,request,handler};
}
module.exports={harness};
