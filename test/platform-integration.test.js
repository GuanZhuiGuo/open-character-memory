import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
const sdk = process.env.PLATFORM_TEST_SDK_PATH;

test('platform identity, scoped model HTTP/SSE and persisted worker actor share the real SDK path', {timeout:30000, skip:!sdk}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'memory-platform-'));
  const calls = [];
  const central = http.createServer(async (req,res) => {
    res.setHeader('Content-Type','application/json');
    assert.equal(req.headers.authorization,'Bearer fixture-service-secret');
    if(req.url === '/internal/platform/session') {
      const cookie=req.headers.cookie||'';
      if(!cookie.includes('mia_session=')) {res.writeHead(401);res.end('{}');return;}
      const id=cookie.includes('owner')?'owner':'user-a';
      res.end(JSON.stringify({user:{user_id:id,tenant_id:'tenant',display_name:id,is_owner:id==='owner'},ticket:'ticket-'+id}));return;
    }
    if(req.url === '/internal/platform/runtime') {
      res.end(JSON.stringify({version:3,capabilities:{llm2:{enabled:true,protocol:'responses',endpoint:'https://ark.cn-beijing.volces.com/api/v3/responses',model:'central-text',secret_values:{api_key:'platform-managed'}},embedding:{enabled:true,protocol:'volc_embedding',endpoint:'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal',model:'central-vector',secret_values:{api_key:'platform-managed'}}}}));return;
    }
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
    calls.push({url:req.url,actor:req.headers['x-platform-actor'],api:req.headers['x-platform-api'],body});
    assert.ok(req.headers['x-platform-actor']);
    assert.notEqual(req.headers.authorization,'Bearer legacy-local-key');
    if(req.url.endsWith('/embedding')) {res.end(JSON.stringify({data:[{embedding:[.1,.2,.3]}],usage:{prompt_tokens:4,total_tokens:4}}));return;}
    if(body.stream) {
      res.setHeader('Content-Type','text/event-stream');
      res.write('event: response.output_item.added\ndata: '+JSON.stringify({type:'response.output_item.added',output_index:0,item:{id:'msg-1',type:'message',role:'assistant',content:[]}})+'\n\n');
      res.write('event: response.output_text.delta\ndata: '+JSON.stringify({type:'response.output_text.delta',item_id:'msg-1',output_index:0,content_index:0,delta:'central stream'})+'\n\n');
      res.end('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id:'resp-stream',status:'completed',model:'central-text',output:[{id:'msg-1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'central stream',annotations:[]}]}],output_text:'central stream',usage:{input_tokens:3,output_tokens:2,total_tokens:5}}})+'\n\n');return;
    }
    res.end(JSON.stringify({id:'resp-test',model:'central-text',output_text:'central answer',usage:{input_tokens:3,output_tokens:2,total_tokens:5}}));
  });
  const port=await listen(central);
  Object.assign(process.env,{PLATFORM_ENABLED:'true',PLATFORM_SERVICE_ID:'memory',PLATFORM_SERVICE_SECRET:'fixture-service-secret',PLATFORM_INTERNAL_ORIGIN:`http://127.0.0.1:${port}`,PLATFORM_SDK_PATH:sdk,DATABASE_PATH:path.join(temporary,'memory.db'),GRAPH_STORE:'sqlite',ARK_API_KEY:'legacy-local-key',TEXT_PROVIDER:'ark',EMBEDDING_PROVIDER:'ark',DEEP_AGENT_RUNTIME_ENABLED:'false',BASE_PATH:''});
  let server,db;
  try {
    const imported=await import('../server.js');server=imported.server;
    db=(await import('../lib/db.js')).db;
    const businessPort=await listen(server);
    const base=`http://127.0.0.1:${businessPort}`;
    let response=await fetch(base+'/api/auth/session');
    assert.equal(response.status,401);
    response=await fetch(base+'/api/auth/session',{headers:{Cookie:'mia_session=member'}});
    const user=await response.json();
    assert.equal(user.authenticated,true);assert.equal(user.role,'user');assert.match(user.user.id,/^platform_/);
    response=await fetch(base+'/api/bootstrap',{headers:{Cookie:'mia_session=member'}});assert.equal(response.status,200);
    response=await fetch(base+'/api/auth/session',{headers:{Cookie:'mia_session=owner'}});
    assert.equal((await response.json()).role,'admin');
    response=await fetch(base+'/api/auth/register',{method:'POST',headers:{Cookie:'mia_session=member','Content-Type':'application/json'},body:'{}'});
    assert.equal(response.status,409);
    const platform=await import('../lib/platform.js');
    const providers=await import('../lib/providers/index.js');
    const fakeResponse={writeHead(){},end(){}};
    await platform.protectPlatformRequest({headers:{cookie:'mia_session=member'},method:'GET',url:'/'},fakeResponse,async()=>{
      const result=await providers.generateText({systemPrompt:'test',messages:[{role:'user',content:'hello'}]});
      assert.equal(result.text,'central answer');assert.equal(result.usage.totalTokens,5);
      const chunks=[];const streamed=await providers.streamText({systemPrompt:'test',messages:[{role:'user',content:'hello'}],onDelta:v=>chunks.push(v)});
      assert.equal(streamed.text,'central stream');assert.equal(chunks.join(''),'central stream');
      const embedded=await providers.embedText('test');assert.deepEqual(embedded.vector,[.1,.2,.3]);
      const {runPiAgent}=await import('../lib/pi-runtime.js');
      const pi=await runPiAgent({systemPrompt:'test',messages:[{role:'user',content:'tool-capable test'}],tools:[{name:'unused',description:'fixture tool',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'unused'}]})}],onStreamEvent:()=>{}});
      assert.equal(pi.text,'central stream');
      platform.capturePlatformJob('deep:fixture-job');
    });
    await platform.withPlatformJob('deep:fixture-job',()=>providers.generateText({systemPrompt:'background',messages:[{role:'user',content:'run'}]}));
    assert.ok(calls.length>=4);assert.ok(calls.every(call=>call.actor==='ticket-user-a'));
    assert.ok(calls.some(call=>call.api==='responses'));assert.ok(calls.some(call=>call.api==='volc_embedding'));
    assert.equal(fs.statSync(path.join(temporary,'platform-delegations.sqlite')).mode&0o777,0o600);
    await assert.rejects(platform.withPlatformJob('deep:unowned',()=>providers.embedText('denied')),/缺少平台用户授权/);
    await assert.rejects(providers.generateText({systemPrompt:'',messages:[{role:'user',content:'unauthenticated'}]}),/Authenticated platform user required/);
    const {config}=await import('../lib/config.js');assert.equal(config.ark.apiKey,'platform-managed');
  } finally {
    if(server?.listening)await close(server);
    db?.close();await close(central);fs.rmSync(temporary,{recursive:true,force:true});
  }
});
