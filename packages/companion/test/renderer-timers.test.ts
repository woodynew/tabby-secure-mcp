import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'

it('accepts real HTTP initialization with Electron numeric timer handles', () => {
  const output = buildSync({
    entryPoints: [fileURLToPath(new URL('../src/plugin.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', write: false,
  }).outputFiles[0]!.text
  // A separate realm keeps Node20's lazily cached Undici timers out of other tests.
  const script = `
    const mod = {exports:{}};
    new Function('require','module','exports',${JSON.stringify(output)})(require,mod,mod.exports);
    const assert = require('node:assert/strict');
    const {request} = require('node:http');
    const nativeTimeout = global.setTimeout;
    const nativeClear = global.clearTimeout;
    const timers = [];
    global.setTimeout = (...args) => { const timer = nativeTimeout(...args);timers.push(timer);return Number(timer); };
    const identity = {id:'A',name:'Named renderer client',generation:1};
    const credentials = {
      list:()=>[{...identity,permission:{kind:'none'}}],
      load:async()=>{},isCurrent:()=>true,authenticate:token=>token==='test-token'?identity:undefined,
      permission:()=>({kind:'none'}),grant:async()=>{},onInvalidated:()=>()=>{},
    };
    const server = new mod.exports.EmbeddedMcpServer({port:0,credentials,audit:async()=>{},approveClient:async()=>'session',dispatch:async()=>({ok:true,result:{profiles:[]}})});
    (async()=>{
      try {
        await server.start();
        const port=server.httpServer.address().port;
        const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}});
        const response=await new Promise((resolve,reject)=>{
          const req=request({host:'127.0.0.1',port,path:'/mcp',method:'POST',headers:{Authorization:'Bearer test-token',Accept:'application/json, text/event-stream','Content-Type':'application/json'}},res=>{
            let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
          });req.on('error',reject);req.end(body);
        });
        assert.equal(response.status,200);
        assert.ok(response.body.result.protocolVersion);
        for(let i=0;i<100&&server.sessionViews()[0]?.state!=='approved';i++)await new Promise(r=>nativeTimeout(r,1));
        assert.equal(server.sessionViews()[0].state,'approved');
      }finally{await server.close();for(const timer of timers)nativeClear(timer);}
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `
  expect(() => execFileSync(process.execPath, ['--input-type=commonjs', '-'], { input: script, timeout: 10_000, stdio: 'pipe' })).not.toThrow()
})
