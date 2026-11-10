import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = process.env.PLATFORM_TEST_SDK_PATH;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));

test('Feishu workspace defaults to its own persisted identity and resources across process restarts', {timeout:45000, skip:!sdk}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-workspace-'));
  let unavailable = false;
  const revoked = new Set();
  let child;
  let output = '';
  const control = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    assert.equal(request.headers.authorization, 'Bearer workspace-fixture-service');
    if (unavailable) { response.writeHead(503); response.end('{}'); return; }
    if (request.url === '/internal/platform/session') {
      const key = /^mia_session=(owner|user-a|user-b|guest-a|guest-b|guest-unbound|guest-missing|guest-invalid)$/.exec(request.headers.cookie || '')?.[1];
      if (!key || revoked.has(key)) { response.writeHead(401); response.end('{}'); return; }
      const guest = key.startsWith('guest-');
      const legacyId = {'guest-a':'user_xiaoyu','guest-b':'user_azhi','guest-missing':'user_not_present_here','guest-invalid':'platform_forbidden'}[key];
      response.end(JSON.stringify({user:{user_id:key,tenant_id:'tenant-a',display_name:guest?'独立访客':'同名飞书成员',username:key,is_owner:key==='owner',
        identity_type:guest?'guest':'feishu',legacy_subject_id:guest?legacyId:'user_xiaoyu'},ticket:'ticket-'+key}));
      return;
    }
    if (request.url === '/internal/platform/runtime') {
      response.end(JSON.stringify({version:1,capabilities:{}}));
      return;
    }
    if (request.url === '/internal/platform/workspace/context') {
      const actor = /^ticket-(owner|user-a|user-b)$/.exec(request.headers['x-platform-actor'] || '')?.[1];
      if (!actor || revoked.has(actor)) { response.writeHead(401); response.end('{}'); return; }
      response.end(JSON.stringify({user:{user_id:actor,tenant_id:'tenant-a',display_name:'同名飞书成员',username:actor,is_owner:actor==='owner'},quota:{remaining_tokens:100},services:[]}));
      return;
    }
    if (request.url === '/internal/platform/workspace/logout') {
      const actor = /^ticket-(owner|user-a|user-b)$/.exec(request.headers['x-platform-actor'] || '')?.[1];
      if (!actor) { response.writeHead(401); response.end('{}'); return; }
      revoked.add(actor);
      response.end('{}');
      return;
    }
    if (request.url === '/api/platform/context') {
      const key = /^mia_session=(owner|user-a|user-b)$/.exec(request.headers.cookie || '')?.[1];
      if (!key) { response.writeHead(401); response.end('{}'); return; }
      response.end(JSON.stringify({user:{user_id:key,tenant_id:'tenant-a',display_name:'同名飞书成员',username:key,can_manage_platform:key==='owner',csrf:'fixture-csrf'},quota:{remaining_tokens:100},services:[]}));
      return;
    }
    response.writeHead(404); response.end('{}');
  });
  const controlPort = await listen(control);
  const reserved = http.createServer();
  const businessPort = await listen(reserved);
  await close(reserved);
  const origin = `http://127.0.0.1:${businessPort}`;
  const base = origin + '/memory-agent';
  const database = path.join(temporary, 'memory.sqlite');
  async function start() {
    child = spawn(process.execPath, ['server.js'], {cwd:root,env:{...process.env,
      HOST:'127.0.0.1',PORT:String(businessPort),BASE_PATH:'/memory-agent',DATABASE_PATH:database,
      PLATFORM_ENABLED:'true',PLATFORM_SERVICE_ID:'memory',PLATFORM_SERVICE_SECRET:'workspace-fixture-service',
      PLATFORM_SDK_PATH:sdk,PLATFORM_SERVICE_ORIGIN:origin,PLATFORM_SERVICE_PATH:'/memory-agent',
      PLATFORM_INTERNAL_ORIGIN:`http://127.0.0.1:${controlPort}`,PLATFORM_PUBLIC_ORIGIN:`http://127.0.0.1:${controlPort}`,
      PLATFORM_DELEGATION_DB:path.join(temporary,'delegations.sqlite'),GRAPH_STORE:'sqlite',
      TEXT_PROVIDER:'mock',EMBEDDING_PROVIDER:'mock',DEEP_AGENT_RUNTIME_ENABLED:'false',DEEP_AGENT_WORKER_MODE:'off',
      SANDBOX_RUNTIME_ENABLED:'false',ARTIFACT_ROOT:path.join(temporary,'artifacts')},stdio:['ignore','pipe','pipe']});
    output = '';
    child.stdout.on('data',chunk => { output += chunk; });
    child.stderr.on('data',chunk => { output += chunk; });
    for (let attempt=0;attempt<100;attempt++) {
      if (child.exitCode !== null) throw new Error('Fixture child failed: '+output);
      try { if ((await fetch(base+'/api/health')).status===200) return; } catch { /* Wait for the private fixture port. */ }
      await new Promise(resolve => setTimeout(resolve,50));
    }
    throw new Error('Fixture child did not listen: '+output);
  }
  async function stop() {
    if (!child || child.exitCode!==null) return;
    const exited = once(child,'exit'); child.kill('SIGTERM'); await exited;
  }
  async function call(route, actor='user-a', body) {
    const response = await fetch(base+route,{method:body===undefined?'GET':'POST',redirect:'manual',headers:{
      ...(actor?{Cookie:'mia_session='+actor}:{}),Origin:origin,'Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json().catch(()=>null)};
  }
  let db;
  try {
    await start();
    db = new DatabaseSync(database);
    const oldUsers = db.prepare('SELECT * FROM users ORDER BY id').all();
    const oldAccounts = db.prepare('SELECT * FROM user_accounts ORDER BY user_id').all();
    const legacyTimestamp = new Date().toISOString();
    db.prepare("INSERT INTO conversations(id,user_id,agent_id,title,created_at,updated_at) VALUES('legacy-conversation','user_xiaoyu','agent_linwan','Preserved guest history',?,?)").run(legacyTimestamp,legacyTimestamp);
    assert.equal((await call('/api/platform/resources',null)).status,401);
    assert.equal((await call('/api/platform/resources','forged')).status,401);
    const first = (await call('/api/auth/session')).body.user;
    const second = (await call('/api/auth/session','user-b')).body.user;
    const changedAccount = await fetch(base+'/api/platform/resources', {headers:{Cookie:'mia_session=user-b','X-Platform-Expected-User':'user-a'}});
    assert.equal(changedAccount.status,409);
    assert.equal((await changedAccount.json()).error.code,'account_changed');
    const owner = (await call('/api/auth/session','owner')).body.user;
    assert.notEqual(first.id,second.id);
    assert.notEqual(first.id,owner.id);
    assert.equal(first.display_name,second.display_name);
    const guestA = await call('/api/auth/session','guest-a');
    const guestB = await call('/api/auth/session','guest-b');
    assert.equal(guestA.status,200);
    assert.equal(guestA.body.user.id,'user_xiaoyu');
    assert.equal(guestA.body.identity.type,'guest');
    assert.equal(guestA.body.identity.display_name,'独立访客');
    assert.equal(guestB.body.user.id,'user_azhi');
    const unboundGuest = await call('/api/auth/session','guest-unbound');
    assert.equal(unboundGuest.status,200);
    assert.match(unboundGuest.body.user.id,/^platform_/);
    const missingGuest = await call('/api/auth/session','guest-missing');
    assert.equal(missingGuest.status,200);
    assert.match(missingGuest.body.user.id,/^platform_/);
    assert.match(missingGuest.body.identity.history_notice,/当前环境不可用/);
    assert.notEqual(missingGuest.body.user.id,unboundGuest.body.user.id);
    assert.equal((await call('/api/auth/session','guest-invalid')).status,403);
    assert.equal((await call('/api/admin/users','guest-a')).status,403);
    assert.equal((await call('/api/conversations?user_id=user_azhi','guest-a')).status,403);
    assert.deepEqual((await call('/api/platform/resources','guest-a')).body.resources.map(item=>item.id),['legacy-conversation']);
    for (const [actor,id] of [['user-a',first.id],['user-b',second.id],['owner',owner.id]]) {
      const bootstrap = await call('/api/bootstrap',actor);
      assert.equal(bootstrap.status,200);
      assert.deepEqual(bootstrap.body.users.map(row=>row.id),[id]);
      const workspace = await call('/api/platform/me',actor);
      assert.equal(workspace.status,200);
      assert.equal(workspace.body.user.user_id,actor);
      for (const route of ['/api/auth/login','/api/auth/register','/api/admin/login']) assert.equal((await call(route,actor,{})).status,409);
    }
    assert.equal((await call('/api/users','owner',{name:'Another local account'})).status,409);
    const agent = 'agent_linwan';
    const own = await call('/api/conversations','user-a',{user_id:first.id,agent_id:agent,title:'First personal conversation'});
    const other = await call('/api/conversations','user-b',{user_id:second.id,agent_id:agent,title:'Other personal conversation'});
    assert.equal(own.status,201);
    assert.equal(other.status,201);
    assert.equal((await call('/api/conversations/'+other.body.id+'?user_id='+second.id)).status,403);
    const timestamp = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO events(id,user_id,agent_id,story_id,branch_id,event_key,event_type,title,summary,created_at,updated_at)
      VALUES(?,?,?,'main_story','main',?,'episode',?,'',?,?)`);
    insert.run('workspace-event-a',first.id,agent,'event-a','First personal memory',timestamp,timestamp);
    insert.run('workspace-event-b',second.id,agent,'event-b','Other personal memory',timestamp,timestamp);
    const personal = await call('/api/platform/resources');
    assert.equal(personal.status,200);
    assert.deepEqual(new Set(personal.body.resources.map(item=>item.id)),new Set([own.body.id,'workspace-event-a']));
    for (const item of personal.body.resources) {
      assert.deepEqual(Object.keys(item).sort(),['id','path','status','title','type','updated_at'].sort());
      assert.match(item.path,/^\/#/);
      assert.doesNotMatch(item.path,/https?:|token|\/\//i);
      const target = new URLSearchParams(item.path.slice(2));
      assert.equal(target.get('agent'),agent);
      assert.equal(target.get(item.type==='conversation'?'conversation':'memory-event'),item.id);
    }
    assert.deepEqual((await call('/api/platform/resources','owner')).body.resources,[]);
    assert.equal((await call('/api/platform/resources?user_id='+first.id,'owner')).status,403);
    assert.equal((await call('/api/admin/users')).status,403);
    assert.equal((await call('/api/admin/users','owner')).status,200);
    assert.deepEqual((await call('/api/bootstrap','owner')).body.users.map(item=>item.id),[owner.id]);
    const page = await fetch(base+'/',{headers:{Cookie:'mia_session=owner'}});
    const markup = await page.text();
    assert.equal(page.status,200);
    assert.ok(page.headers.get('Content-Security-Policy').includes(`http://127.0.0.1:${controlPort}`));
    assert.match(markup,/data-platform="true"/);
    assert.match(markup,/正在连接个人工作空间/);
    assert.doesNotMatch(markup,/id="(?:loginOverlay|registerForm|userLoginForm|adminLoginForm)"/);
    assert.match(markup,/workspace[^"\s]*\.js|workspace-shell/);
    unavailable = true;
    assert.equal((await call('/api/auth/session')).status,503);
    unavailable = false;
    await stop();
    await start();
    assert.equal((await call('/api/auth/session')).body.user.id,first.id);
    assert.equal((await call('/api/auth/session','guest-a')).body.user.id,'user_xiaoyu');
    assert.deepEqual((await call('/api/platform/resources')).body,personal.body);
    assert.deepEqual(db.prepare('SELECT * FROM user_accounts ORDER BY user_id').all(),oldAccounts);
    for (const old of oldUsers) assert.deepEqual(db.prepare('SELECT * FROM users WHERE id=?').get(old.id),old);
    assert.equal((await call('/api/platform/logout','user-a',{})).status,200);
    assert.equal((await call('/api/auth/session')).status,401);
    assert.equal((await call('/api/auth/session','user-b')).status,200);
  } finally {
    await stop(); db?.close(); await close(control);
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});
