import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest, routePinnedModel, setRoutingStrategy, type ChainRow, type RouteResult } from '../../services/router.js';
import { acquireLease, releaseLease, resetLeases, canUseKeyConcurrency, clearAllCooldowns, setCooldown, isOnCooldown } from '../../services/ratelimit.js';
import { runCooldownProbePass, resetCooldownProbeState } from '../../services/cooldown-probe.js';
import { routingExhaustionBody, cooldownDecisionForError, SENSENOVA_QUOTA_COOLDOWN_MS, SENSENOVA_WEEKLY_RECHECK_MS } from '../../lib/fallback-loop.js';

function addKey(label: string, baseUrl: string): number {
  const key = encrypt('test-fixture-' + label);
  return Number(getDb().prepare(`INSERT INTO api_keys
    (platform,label,base_url,encrypted_key,iv,auth_tag,status,enabled)
    VALUES ('custom',?,?,?,?,?,'healthy',1)`)
    .run(label,baseUrl,key.encrypted,key.iv,key.authTag).lastInsertRowid);
}
function binding(keyId: number, priority: number, model = 'sense-test-chat', scope = `token.sensenova.cn-v1-legacy-key-${keyId}`): ChainRow {
  const db = getDb();
  const id = Number(db.prepare(`INSERT INTO models
    (platform,model_id,display_name,intelligence_rank,speed_rank,key_id,endpoint_scope,enabled,supports_tools,context_window)
    VALUES ('custom',?,?,1,1,?,?,1,1,1048576)`)
    .run(model,model,keyId,scope).lastInsertRowid);
  return { model_db_id:id,priority,enabled:1,platform:'custom',model_id:model,display_name:model,
    intelligence_rank:1,size_label:'',monthly_token_budget:'',rpm_limit:null,rpd_limit:null,
    tpm_limit:null,tpd_limit:null,supports_vision:0,supports_tools:1,context_window:1048576,
    key_id:keyId,endpoint_scope:scope };
}
function senseKeys(): number[] {
  return [1,2,3].map(n => addKey('sensenova-test-' + n,'https://token.sensenova.cn/v1'));
}
function route(chain: ChainRow[], preferred?: number, tokens = 100): RouteResult {
  return routeRequest(tokens,new Set(),preferred,false,false,new Set(),chain);
}
function observation(keyId: number, status: string, tokens: number, error: string | null = null, ageMs = 0, model = 'sense-test-chat') {
  getDb().prepare(`INSERT INTO requests (platform,model_id,key_id,status,input_tokens,output_tokens,latency_ms,error,created_at)
    VALUES ('custom',?,?,?,?,0,100,?,?)`).run(model,keyId,status,tokens,error,
      new Date(Date.now()-ageMs).toISOString().slice(0,19).replace('T',' '));
}
function failure(chain: ChainRow[]) {
  try { route(chain); } catch (error) { return error; }
  throw new Error('Expected exhausted routing');
}
beforeAll(() => { process.env.ENCRYPTION_KEY='0'.repeat(64); initDb(':memory:'); });
beforeEach(() => {
  clearAllCooldowns(); resetLeases(); resetCooldownProbeState();
  getDb().prepare("DELETE FROM models WHERE platform='custom' AND model_id IN ('sense-test-chat','other-model')").run();
  getDb().prepare('DELETE FROM api_keys').run();
  getDb().prepare("DELETE FROM requests WHERE platform='custom' AND model_id IN ('sense-test-chat','other-model')").run();
  getDb().prepare("DELETE FROM settings WHERE key IN ('active_profile_id','routing_cooldown_ceiling_ms')").run();
  setRoutingStrategy('priority');
  vi.stubEnv('SENSENOVA_MAX_CONCURRENT_REQUESTS_PER_KEY','1');
  vi.stubEnv('MAX_CONCURRENT_REQUESTS_PER_KEY','');
  vi.stubEnv('MAX_CONCURRENT_REQUESTS_PER_KEY_CUSTOM','');
});
afterEach(() => { resetLeases(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('SenseNova independent-key routing', () => {
  it('also avoids large requests on a key that recently rejected even a tiny request', () => {
    const ids=senseKeys();const chain=ids.map((id,i)=>binding(id,i+1));
    observation(ids[0],'error',5,'Custom (OpenAI-compatible) API error 429: inference exceeds tpm/rpm limit');
    const r=route(chain,undefined,100_000);expect(r.keyId).toBe(ids[1]);r.release?.();
  });
  it('prefers a recently successful key over a large-request 429 after cooldown expiry', () => {
    const ids=senseKeys();const chain=ids.map((id,i)=>binding(id,i+1));
    observation(ids[0],'error',150_000,'Custom (OpenAI-compatible) API error 429: inference exceeds tpm/rpm limit');
    observation(ids[1],'success',200_000);
    const r=route(chain,chain[0].model_db_id,100_000);
    expect(r.keyId).toBe(ids[1]);expect(r.modelId).toBe('sense-test-chat');r.release?.();
  });
  it('does not let a tiny successful probe hide repeated large-request limits', () => {
    const ids=senseKeys();const chain=ids.map((id,i)=>binding(id,i+1));
    observation(ids[0],'error',150_000,'Custom (OpenAI-compatible) API error 429: inference exceeds tpm/rpm limit');
    observation(ids[0],'success',30);observation(ids[1],'success',200_000);
    const r=route(chain,undefined,100_000);expect(r.keyId).toBe(ids[1]);r.release?.();
  });
  it('allows a small request to use a key that was rate-limited only on a large request', () => {
    const ids=senseKeys();const chain=ids.map((id,i)=>binding(id,i+1));
    observation(ids[0],'error',150_000,'Custom (OpenAI-compatible) API error 429: inference exceeds tpm/rpm limit');
    const r=route(chain);expect(r.keyId).toBe(ids[0]);r.release?.();
  });
  it('reconsiders keys after the inference-history preference window expires', () => {
    const ids=senseKeys();const chain=ids.map((id,i)=>binding(id,i+1));
    observation(ids[0],'error',150_000,'Custom (OpenAI-compatible) API error 429: inference exceeds tpm/rpm limit',31*60_000);
    const r=route(chain,undefined,100_000);expect(r.keyId).toBe(ids[0]);r.release?.();
  });
  it('does not treat transport errors, cancellations, or another model as this model\'s rate limits', () => {
    const ids=senseKeys();const chain=ids.map((id,i)=>binding(id,i+1));
    observation(ids[0],'error',150_000,'connect timeout');
    observation(ids[0],'canceled',150_000,'client disconnected');
    observation(ids[0],'error',150_000,'Custom (OpenAI-compatible) API error 429: inference exceeds tpm/rpm limit',0,'other-model');
    const r=route(chain,undefined,100_000);expect(r.keyId).toBe(ids[0]);r.release?.();
  });
  it('keeps explicit pins and concurrency gates even when reliability preferences differ', () => {
    const ids=senseKeys();const chain=ids.map((id,i)=>binding(id,i+1));
    observation(ids[0],'error',150_000,'Custom (OpenAI-compatible) API error 429: inference exceeds tpm/rpm limit');
    const pinned=routePinnedModel(chain[0].model_db_id,100_000);expect(pinned!.keyId).toBe(ids[0]);pinned!.release?.();
    const active=route(chain,undefined,100_000);const next=route(chain,undefined,100_000);
    expect(active.keyId).not.toBe(next.keyId);active.release?.();next.release?.();
  });
  it('rotates sequential requests across all three bindings without replacing model identities', () => {
    const ids=senseKeys(); const chain=ids.map((id,i)=>binding(id,i+1));
    const selected=[];
    for(let i=0;i<6;i++) {
      const r=route(chain); selected.push(r.keyId);
      expect(r.modelDbId).toBe(chain.find(x=>x.key_id===r.keyId)!.model_db_id);
      expect(r.modelId).toBe('sense-test-chat'); r.release?.();
    }
    expect(selected).toEqual([...ids,...ids]);
  });
  it('routes three overlapping requests to separate credentials and reports a fourth as busy', () => {
    const ids=senseKeys();const chain=ids.map((id,i)=>binding(id,i+1));
    const active=[route(chain),route(chain),route(chain)];
    expect(new Set(active.map(x=>x.keyId)).size).toBe(3);
    const body=routingExhaustionBody(failure(chain));
    expect(body.status).toBe(429); expect(body.code).toBe('rate_limit_exceeded');
    expect(body.retryAtMs).toBeGreaterThanOrEqual(Date.now()+4_900);
    active[0].release?.(); expect(route(chain).keyId).toBe(active[0].keyId);
    active.forEach(x=>x.release?.());
  });
  it('preserves an explicit model binding pin', () => {
    const ids=senseKeys();const chain=ids.map((id,i)=>binding(id,i+1));
    const r=route([chain[2]],chain[2].model_db_id);expect(r.keyId).toBe(ids[2]);r.release?.();
    const pinned=routePinnedModel(chain[0].model_db_id,100);expect(pinned!.keyId).toBe(ids[0]);pinned!.release?.();
  });
  it('keeps the sticky model while rotating its independent credentials', () => {
    const ids=senseKeys();const chain=ids.map((id,i)=>binding(id,i+1));const selected=[];
    for(let i=0;i<6;i++){
      const r=route(chain,chain[0].model_db_id);selected.push(r.keyId);
      expect(r.modelId).toBe('sense-test-chat');r.release?.();
    }
    expect(selected).toEqual([...ids,...ids]);
  });
  it('leaves a higher-priority other model in its existing position', () => {
    const ids=senseKeys();const other=binding(ids[0],0,'other-model');
    const chain=[other,...ids.map((id,i)=>binding(id,i+1))];
    expect(route(chain).modelDbId).toBe(other.model_db_id);
  });
  it('does not apply the SenseNova concurrency gate to CPA or other custom credentials', () => {
    const sense=addKey('sensenova-test','https://token.sensenova.cn/v1');
    const cpa=addKey('test-cpa','http://127.0.0.1:18317/v1');
    const lease=acquireLease('custom','chat',sense,100);
    const cpaLease=acquireLease('custom','chat',cpa,100);
    expect(canUseKeyConcurrency('custom',sense)).toBe(false);
    expect(canUseKeyConcurrency('custom',cpa)).toBe(true);
    releaseLease(lease);releaseLease(cpaLease);
  });
  it('allows an explicit endpoint concurrency override and still honors a stricter platform gate', () => {
    const id=senseKeys()[0];vi.stubEnv('SENSENOVA_MAX_CONCURRENT_REQUESTS_PER_KEY','2');
    acquireLease('custom','chat',id,100);expect(canUseKeyConcurrency('custom',id)).toBe(true);
    vi.stubEnv('MAX_CONCURRENT_REQUESTS_PER_KEY_CUSTOM','1');expect(canUseKeyConcurrency('custom',id)).toBe(false);
  });
});

describe('exhaustion and cooldown recovery', () => {
  it('returns 429 and this model\'s earliest expiry despite mismatch diagnostics and unrelated cooldowns', () => {
    const ids=senseKeys();const chain=ids.map((id,i)=>binding(id,i+1));const start=Date.now();
    ids.forEach((id,i)=>setCooldown('custom','sense-test-chat',id,(i+1)*90_000));
    const cpa=addKey('test-cpa','http://127.0.0.1:18317/v1');setCooldown('custom','unrelated',cpa,1_000);
    const err=failure(chain) as {diagnostics:string[]};
    expect(err.diagnostics.join('\n')).toContain('custom-key-mismatch');
    const body=routingExhaustionBody(err);expect(body.status).toBe(429);expect(body.code).toBe('rate_limit_exceeded');
    expect(body.retryAtMs).toBeGreaterThanOrEqual(start+90_000);expect(body.retryAtMs).toBeLessThan(start+91_000);
  });
  it('keeps configuration-only mismatches as 503 and recognizes a monthly cap beside mismatches', () => {
    expect(routingExhaustionBody({diagnostics:['custom/chat: 3 key(s) — custom-key-mismatch:3']}).status).toBe(503);
    const body=routingExhaustionBody({diagnostics:['custom/chat: 3 key(s) — custom-key-mismatch:2, monthly-budget-cap:1']});
    expect(body.status).toBe(429);expect(body.code).toBe('quota_exceeded');
  });
  it('does not clear SenseNova inference cooldowns when credential probes pass, while normal recovery still works', async () => {
    const sense=senseKeys()[0];const cpa=addKey('test-cpa','http://127.0.0.1:18317/v1');
    setCooldown('custom','sense-test-chat',sense,600_000,'heuristic');
    setCooldown('custom','other-chat',cpa,600_000,'heuristic');
    const now=Date.now()+360_000;const probe=vi.fn(async()=> 'valid' as const);
    await runCooldownProbePass({now,probe,jitter:()=>0});
    await runCooldownProbePass({now,probe,jitter:()=>0});
    expect(probe).not.toHaveBeenCalledWith(sense);expect(probe).toHaveBeenCalledWith(cpa);
    expect(isOnCooldown('custom','sense-test-chat',sense)).toBe(true);
    expect(isOnCooldown('custom','other-chat',cpa)).toBe(false);
  });
  it('uses the official five-hour plan window, respects provider resets, and only jitters inferred rate limits', () => {
    const id=senseKeys()[0];const r={platform:'custom',keyId:id,modelId:'policy-test',rpdLimit:null,tpdLimit:null} as RouteResult;
    const plan=cooldownDecisionForError(r,Object.assign(new Error('token plan limit'),{status:429}));
    expect(plan).toEqual({durationMs:SENSENOVA_QUOTA_COOLDOWN_MS,source:'authoritative'});
    expect(SENSENOVA_QUOTA_COOLDOWN_MS).toBe(5*60*60*1000);
    const reset=cooldownDecisionForError(r,Object.assign(new Error('FREE_QUOTA_EXHAUSTED'),{retryAfterMs:600_000}));
    expect(reset).toEqual({durationMs:600_000,source:'authoritative'});
    const points=cooldownDecisionForError(r,new Error('insufficient points'));
    expect(points.durationMs).toBe(SENSENOVA_QUOTA_COOLDOWN_MS);
    const weekly=cooldownDecisionForError(r,new Error('weekly credit limit exceeded'));
    expect(weekly).toEqual({durationMs:SENSENOVA_WEEKLY_RECHECK_MS,source:'heuristic'});
    const weekReset=cooldownDecisionForError(r,Object.assign(new Error('weekly credit limit exceeded'),{retryAfterMs:7_200_000}));
    expect(weekReset).toEqual({durationMs:7_200_000,source:'authoritative'});
    const stated=cooldownDecisionForError(r,Object.assign(new Error('429 inference exceeds tpm/rpm limit'),{retryAfterMs:900_000}));
    expect(stated).toEqual({durationMs:900_000,source:'authoritative'});
    const inferred=cooldownDecisionForError({...r,modelId:'jitter-test'},new Error('429 inference exceeds tpm/rpm limit'));
    expect(inferred.source).toBe('heuristic');expect(inferred.durationMs).toBeGreaterThanOrEqual(90_000);expect(inferred.durationMs).toBeLessThanOrEqual(99_000);
  });
});
