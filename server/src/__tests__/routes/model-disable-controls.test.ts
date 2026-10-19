import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { registerCustomChatModels } from '../../services/custom-model-register.js';
import { getModelGroups, resolveRequestedIdForDispatch } from '../../services/model-groups.js';
import { resolveModelGroupCandidates } from '../../services/router.js';
import { mintDashboardToken } from '../helpers/auth.js';

let app: Express;
let server: Server;
let baseUrl: string;
let token: string;
let customId: number;
let customKeyId: number;
let nativeId: number;
const endpoint = 'https://disable-control.example/v1';

async function request(method: string, route: string, body?: unknown) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  token = mintDashboardToken();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test address');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const db = getDb();
  const secret = encrypt('disable-controls-test-key');
  const info = db.prepare(`INSERT INTO api_keys
    (platform, label, encrypted_key, iv, auth_tag, enabled, status, base_url)
    VALUES ('custom', 'test endpoint', ?, ?, ?, 1, 'healthy', ?)`)
    .run(secret.encrypted, secret.iv, secret.authTag, endpoint);
  customKeyId = Number(info.lastInsertRowid);
  customId = registerCustomChatModels(db, endpoint, customKeyId, [
    { modelId: 'deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash (Test endpoint)' },
  ])[0].modelDbId;
  const native = await request('POST', '/api/models', {
    platform: 'nvidia', modelId: 'disable-controls/deepseek-v4.1-flash',
    displayName: 'DeepSeek V4.1 Flash (NVIDIA)',
  });
  expect(native.status).toBe(201);
  nativeId = native.body.id;
});

afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('Global model controls', () => {
  it('excludes a globally disabled custom binding from explicit group routing while retaining NVIDIA', async () => {
    expect((await request('PATCH', `/api/models/${customId}`, { enabled: false })).status).toBe(200);
    const resolved = resolveRequestedIdForDispatch('deepseek-v4.1-flash', getModelGroups());
    expect(resolved).not.toBeNull();
    const candidates = resolveModelGroupCandidates(resolved!.memberDbIds, resolved!.demotedDbIds);
    expect(candidates.map(row => row.model_db_id)).not.toContain(customId);
    expect(candidates.map(row => row.model_db_id)).toContain(nativeId);
  });

  it('keeps default pickers free of disabled rows and exposes their two states in management reads', async () => {
    await request('PATCH', `/api/models/${customId}`, { enabled: false });
    const normal = await request('GET', '/api/fallback');
    expect(normal.body.find((row: { modelDbId: number }) => row.modelDbId === customId)).toBeUndefined();
    const all = await request('GET', '/api/fallback?includeDisabled=1');
    expect(all.body.find((row: { modelDbId: number }) => row.modelDbId === customId))
      .toMatchObject({ enabled: false, modelEnabled: false });
    getDb().prepare("DELETE FROM settings WHERE key='active_profile_id'").run();
    const global = await request('GET', '/api/fallback?includeDisabled=1');
    expect(global.body.find((row: { modelDbId: number }) => row.modelDbId === customId))
      .toMatchObject({ enabled: false, modelEnabled: false });
  });

  it('preserves a disabled binding and its display name when the upstream model list is refreshed', async () => {
    await request('PATCH', `/api/models/${customId}`, { enabled: false });
    const registered = registerCustomChatModels(getDb(), endpoint, customKeyId, [
      { modelId: 'deepseek-v4.1-flash', displayName: null },
    ]);
    expect(registered[0]).toMatchObject({ modelDbId: customId, created: false });
    expect(getDb().prepare('SELECT enabled,display_name FROM models WHERE id=?').get(customId))
      .toMatchObject({ enabled: 0, display_name: 'DeepSeek V4.1 Flash (Test endpoint)' });
  });

  it('adds new models enabled and requires an explicit enable action for an existing disabled model', async () => {
    await request('PATCH', `/api/models/${customId}`, { enabled: false });
    const newModel = registerCustomChatModels(getDb(), endpoint, customKeyId, [
      { modelId: 'new-flash-model', displayName: null },
    ])[0];
    expect(getDb().prepare('SELECT enabled FROM models WHERE id=?').get(newModel.modelDbId)).toMatchObject({ enabled: 1 });
    expect((await request('PATCH', `/api/models/${customId}`, { enabled: true })).status).toBe(200);
    const all = await request('GET', '/api/fallback?includeDisabled=1');
    expect(all.body.find((row: { modelDbId: number }) => row.modelDbId === customId))
      .toMatchObject({ modelEnabled: true, enabled: false });
  });
});
