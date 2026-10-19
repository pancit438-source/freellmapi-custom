import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { modelStatsKey, qualifiedModelMemberId, endpointRefMatches } from '../../lib/endpoint-scope.js';
import { routePinnedModel, hasOtherUsableKey } from '../../services/router.js';
import { registerCustomChatModels } from '../../services/custom-model-register.js';
import { runCustomModelSync } from '../../services/custom-model-sync.js';
import { getModelGroups, resolveRequestedIdToMembers } from '../../services/model-groups.js';
import { logRequest } from '../../lib/request-log.js';
import { modelsRouter } from '../../routes/models.js';
import { registeredModelIds, registerDiscoveredModels } from '../../services/builtin-model-discovery.js';
import { applyDeclarativeConfig } from '../../services/declarative-config.js';
import express from 'express';

vi.mock('../../services/model-discovery.js', () => ({
  discoverEndpointModels: vi.fn(async () => [{ id: 'legacy-probe' }]),
}));

const endpoint = 'https://relay.example.invalid/v1';
function addKey(platform: string, baseUrl: string | null = null): number {
  const c = encrypt('deployment-fixture-key');
  return Number(getDb().prepare("INSERT INTO api_keys(platform,label,encrypted_key,iv,auth_tag,status,enabled,base_url) VALUES(?,?,?,?,?,'healthy',1,?)")
    .run(platform, 'fixture', c.encrypted, c.iv, c.authTag, baseUrl).lastInsertRowid);
}
function addModel(platform: string, keyId: number | null, scope: string, modelId = 'legacy-probe'): number {
  return Number(getDb().prepare("INSERT INTO models(platform,model_id,display_name,intelligence_rank,speed_rank,enabled,key_id,source,endpoint_scope,supports_tools) VALUES(?,?,?,1,1,1,?,'user',?,1)")
    .run(platform, modelId, modelId, keyId, scope).lastInsertRowid);
}

describe('deployment legacy database compatibility', () => {
  beforeAll(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
  beforeEach(() => {
    const db = getDb();
    for (const table of ['profile_models','fallback_config','models','api_keys','custom_model_tombstones','requests','rate_limit_cooldowns']) db.prepare('DELETE FROM '+table).run();
    db.prepare("DELETE FROM settings WHERE key IN ('active_profile_id','model_unify_overrides')").run();
  });

  it('keeps native public identity and history; custom endpoints remain distinguishable', () => {
    expect(modelStatsKey('github','openai/gpt-4.1','legacy-key:15')).toBe('github:openai/gpt-4.1');
    expect(qualifiedModelMemberId('github','openai/gpt-4.1','legacy-key:15')).toBeNull();
    expect(modelStatsKey('custom','legacy-probe',endpoint+'#legacy-key:23')).toBe(modelStatsKey('custom','legacy-probe',endpoint));
    expect(modelStatsKey('custom','legacy-probe','https://other.example.invalid/v1')).not.toBe(modelStatsKey('custom','legacy-probe',endpoint));
    expect(qualifiedModelMemberId('custom','legacy-probe',endpoint+'#legacy-key:23')).not.toBe(qualifiedModelMemberId('custom','legacy-probe',endpoint));
    expect(endpointRefMatches('relay.example.invalid-v1-legacy-key-23',endpoint+'#legacy-key:23')).toBe(true);
  });

  it('preserves native provider pooling even when the model has a key anchor', () => {
    const first = addKey('groq'), second = addKey('groq');
    const id = addModel('groq',first,'legacy-key:'+first,'llama-3.3-70b-versatile');
    const route = routePinnedModel(id,1,new Set(['groq:llama-3.3-70b-versatile:'+first]));
    expect(route?.keyId).toBe(second); route?.release();
    expect(hasOtherUsableKey(id,first)).toBe(true);
  });

  it('preserves old custom single-key routing for canonical and legacy rows', () => {
    const first = addKey('custom',endpoint), second = addKey('custom',endpoint);
    const a = addModel('custom',first,endpoint), b = addModel('custom',second,endpoint+'#legacy-key:'+second);
    for (const [id,key] of [[a,first],[b,second]]) {
      const route = routePinnedModel(id,1); expect(route?.keyId).toBe(key); route?.release();
      expect(routePinnedModel(id,1,new Set(['custom:legacy-probe:'+key]))).toBeNull();
      expect(hasOtherUsableKey(id,key)).toBe(false);
    }
    const groups=getModelGroups();
    for (const [id,scope] of [[a,endpoint],[b,endpoint+'#legacy-key:'+second]] as const) {
      const qualified=qualifiedModelMemberId('custom','legacy-probe',scope)!;
      expect(resolveRequestedIdToMembers(qualified,groups)).toEqual([id]);
    }
  });

  it('refreshes the matching key row and reuses surviving legacy identity after canonical deletion', () => {
    const db=getDb(), first=addKey('custom',endpoint), second=addKey('custom',endpoint);
    const a=addModel('custom',first,endpoint), b=addModel('custom',second,endpoint+'#legacy-key:'+second);
    const entry=[{modelId:'legacy-probe',displayName:null}];
    expect(registerCustomChatModels(db,endpoint,second,entry)[0].modelDbId).toBe(b);
    expect(db.prepare('SELECT key_id FROM models WHERE id=?').get(a)).toEqual({key_id:first});
    db.prepare('DELETE FROM fallback_config WHERE model_db_id=?').run(a);
    db.prepare('DELETE FROM profile_models WHERE model_db_id=?').run(a);
    db.prepare('DELETE FROM models WHERE id=?').run(a);
    expect(registerCustomChatModels(db,endpoint,first,entry)[0].modelDbId).toBe(b);
    expect(db.prepare('SELECT key_id FROM models WHERE id=?').get(b)).toEqual({key_id:second});
    expect(db.prepare('SELECT count(*) AS n FROM models').get()).toEqual({n:1});
  });

  it('scheduled sync does not recreate a deleted canonical while a legacy sibling survives', async () => {
    const first=addKey('custom',endpoint), second=addKey('custom',endpoint);
    const b=addModel('custom',second,endpoint+'#legacy-key:'+second);
    const result=await runCustomModelSync(getDb());
    expect(result.added).toBe(0);expect(result.skipped).toBe(1);expect(result.failures).toEqual([]);
    expect(getDb().prepare('SELECT id,key_id FROM models').all()).toEqual([{id:b,key_id:second}]);
    expect(first).not.toBe(second);
  });

  it('deleting one old credential row does not tombstone the surviving endpoint model', async () => {
    const first=addKey('custom',endpoint), second=addKey('custom',endpoint);
    const a=addModel('custom',first,endpoint), b=addModel('custom',second,endpoint+'#legacy-key:'+second);
    const app=express();app.use(modelsRouter);const server=app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',resolve));
    try {
      const address=server.address() as {port:number}; const base='http://127.0.0.1:'+address.port;
      expect((await fetch(base+'/custom/'+b,{method:'DELETE'})).status).toBe(200);
      expect(getDb().prepare('SELECT count(*) AS n FROM custom_model_tombstones').get()).toEqual({n:0});
      expect((await fetch(base+'/custom/'+a,{method:'DELETE'})).status).toBe(200);
      expect(getDb().prepare('SELECT count(*) AS n FROM custom_model_tombstones').get()).toEqual({n:1});
    } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
  });

  it('attributes a custom request to its actual credential-bound model row', () => {
    const first=addKey('custom',endpoint), second=addKey('custom',endpoint);
    addModel('custom',first,endpoint); const b=addModel('custom',second,endpoint+'#legacy-key:'+second);
    logRequest('custom','legacy-probe',second,'success',1,1,10,null);
    expect(getDb().prepare('SELECT model_db_id FROM requests ORDER BY id DESC LIMIT 1').get()).toEqual({model_db_id:b});
  });

  it('manual Add rejects a duplicate surviving custom or native legacy identity', async () => {
    const first=addKey('custom',endpoint), second=addKey('custom',endpoint), nativeKey=addKey('groq');
    const custom=addModel('custom',second,endpoint+'#legacy-key:'+second);
    const native=addModel('groq',nativeKey,'legacy-key:'+nativeKey,'llama-3.3-70b-versatile');
    const app=express();app.use(express.json());app.use(modelsRouter);const server=app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',resolve));
    try {
      const address=server.address() as {port:number}; const url='http://127.0.0.1:'+address.port+'/';
      for (const body of [{platform:'custom',modelId:'legacy-probe',keyId:first},{platform:'groq',modelId:'llama-3.3-70b-versatile'}]) {
        expect((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status).toBe(409);
      }
      expect(getDb().prepare('SELECT id FROM models ORDER BY id').all()).toEqual([{id:custom},{id:native}]);
    } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
  });

  it('native discovery keeps surviving key rows when their canonical was deleted', () => {
    const key=addKey('groq'); const id=addModel('groq',key,'legacy-key:'+key,'llama-3.3-70b-versatile');
    expect(registeredModelIds(getDb(),'groq').has('llama-3.3-70b-versatile')).toBe(true);
    const result=registerDiscoveredModels(getDb(),'groq',[{modelId:'llama-3.3-70b-versatile'}],{explicit:false});
    expect(result.created).toEqual([]);expect(result.existing).toEqual(['llama-3.3-70b-versatile']);
    expect(getDb().prepare('SELECT id,key_id FROM models').all()).toEqual([{id,key_id:key}]);
  });

  it('disabled missing-history placeholders cannot serve or be automatically discovered', () => {
    const id=addModel('legacy-deleted',null,'','__legacy_deleted_model_171');
    getDb().prepare('UPDATE models SET enabled=0 WHERE id=?').run(id);
    expect(routePinnedModel(id,1)).toBeNull();
    const result=registerDiscoveredModels(getDb(),'groq',[{modelId:'llama-3.3-70b-versatile'}],{explicit:false});
    expect(result.created).toEqual(['llama-3.3-70b-versatile']);
    expect(getDb().prepare('SELECT enabled,key_id FROM models WHERE id=?').get(id)).toEqual({enabled:0,key_id:null});
  });

  it('native declaration edits the existing canonical or first surviving row without ambiguity', () => {
    const key=addKey('groq'); const id=addModel('groq',key,'legacy-key:'+key,'llama-3.3-70b-versatile');
    applyDeclarativeConfig({models:[{platform:'groq',modelId:'llama-3.3-70b-versatile',displayName:'Edited fixture'}]},'deployment-fixture');
    expect(getDb().prepare('SELECT id,key_id,display_name FROM models').all()).toEqual([{id,key_id:key,display_name:'Edited fixture'}]);
  });

  it('registers new legacy endpoint models per key without touching old disabled rows, keys or cooldowns', () => {
    const db=getDb(), keys=[addKey('custom',endpoint),addKey('custom',endpoint),addKey('custom',endpoint)];
    const old=keys.map((key,i)=>addModel('custom',key,i===0?endpoint:endpoint+'#legacy-key:'+key));
    db.prepare('UPDATE models SET enabled=0 WHERE id=?').run(old[0]);
    const cooldownStart=Date.now();
    db.prepare("INSERT INTO rate_limit_cooldowns(platform,model_id,key_id,expires_at_ms,source,set_at_ms) VALUES('custom','legacy-probe',?,?,'authoritative',?)")
      .run(keys[0],cooldownStart+4*60*60*1000,cooldownStart);
    const oldRows=old.map(id=>db.prepare('SELECT * FROM models WHERE id=?').get(id));
    const beforeKeys=db.prepare('SELECT * FROM api_keys ORDER BY id').all();
    const beforeCooldowns=db.prepare('SELECT * FROM rate_limit_cooldowns').all();
    const entry=[{modelId:'fresh-sensenova-fixture',displayName:null}];
    const added=keys.map(key=>db.transaction(()=>registerCustomChatModels(db,endpoint,key,entry))()[0]);
    expect(new Set(added.map(row=>row.modelDbId)).size).toBe(3);
    for(const [i,key] of keys.entries()) {
      const row=db.prepare('SELECT key_id,endpoint_scope FROM models WHERE id=?').get(added[i].modelDbId);
      expect(row).toEqual({key_id:key,endpoint_scope:i===0?endpoint:endpoint+'#legacy-key:'+key});
      expect(registerCustomChatModels(db,endpoint,key,entry)[0].modelDbId).toBe(added[i].modelDbId);
      const route=routePinnedModel(added[i].modelDbId,1);expect(route?.keyId).toBe(key);route?.release();
      expect(hasOtherUsableKey(added[i].modelDbId,key)).toBe(false);
    }
    expect(old.map(id=>db.prepare('SELECT * FROM models WHERE id=?').get(id))).toEqual(oldRows);
    expect(db.prepare('SELECT * FROM api_keys ORDER BY id').all()).toEqual(beforeKeys);
    expect(db.prepare('SELECT * FROM rate_limit_cooldowns').all()).toEqual(beforeCooldowns);
    expect(db.prepare('SELECT count(*) AS n FROM models').get()).toEqual({n:6});
  });

  it('keeps ordinary endpoints on one canonical row even when another endpoint has legacy rows', () => {
    const legacyFirst=addKey('custom',endpoint),legacySecond=addKey('custom',endpoint);
    addModel('custom',legacyFirst,endpoint);addModel('custom',legacySecond,endpoint+'#legacy-key:'+legacySecond);
    const other='https://ordinary.example.invalid/v1',first=addKey('custom',other),second=addKey('custom',other);
    const entry=[{modelId:'shared-fresh-fixture',displayName:null}];
    const a=registerCustomChatModels(getDb(),other,first,entry)[0],b=registerCustomChatModels(getDb(),other,second,entry)[0];
    expect(b.modelDbId).toBe(a.modelDbId);
    expect(getDb().prepare('SELECT key_id,endpoint_scope FROM models WHERE id=?').get(a.modelDbId)).toEqual({key_id:first,endpoint_scope:other});
  });
});
