import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const { routeRequest } = vi.hoisted(() => ({ routeRequest: vi.fn() }));
vi.mock('../../services/router.js', async (original) => ({ ...await original<any>(), routeRequest }));
vi.mock('../../lib/codex-stream-transport.js', async (original) => {
  const actual = await original<typeof import('../../lib/codex-stream-transport.js')>();
  return { ...actual, startCodexPendingStream: (res: any, enabled: boolean) => actual.startCodexPendingStream(res, enabled, 20) };
});
import { createApp } from '../../app.js';
import { getUnifiedApiKey, initDb } from '../../db/index.js';
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let base: string; let key: string;
const wait = () => new Promise(resolve => setTimeout(resolve, 80));
function fakeRoute(provider: any, id = 1) {
  return { provider, modelId: `fake-model-${id}`, modelDbId: 9000 + id, apiKey: 'fake', keyId: id, platform: 'fake', displayName: 'Fake' };
}
async function request(path: string, stream = true, ua = 'Codex Desktop/0.162') {
  const response = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': ua }, body: JSON.stringify(path.includes('responses') ? { input: 'hello', stream } : { messages: [{ role: 'user', content: 'hello' }], stream }) });
  return { status: response.status, text: await response.text(), type: response.headers.get('content-type') };
}
beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64); process.env.FALLBACK_TIME_BUDGET_MS = '0';
  initDb(':memory:'); key = getUnifiedApiKey(); server = createApp().listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => routeRequest.mockReset());
describe('slow Codex HTTP streams', () => {
  it.each(['/v1/chat/completions', '/v1/responses'])('reports a slow fatal error honestly on %s', async (path) => {
    routeRequest.mockReturnValue(fakeRoute({ async *streamChatCompletion() { await wait(); throw Object.assign(new Error('test fatal rejection'), { status: 418 }); } }));
    const result = await request(path);
    expect(result.status).toBe(200); expect(result.type).toContain('text/event-stream');
    expect(result.text).toContain(': upstream pending'); expect(result.text).toContain('test fatal rejection');
    expect(result.text).not.toContain('response.completed');
    if (path.includes('responses')) expect(result.text).toContain('response.failed');
    else expect(result.text).toContain('"http_status":502');
  });
  it.each(['/v1/chat/completions', '/v1/responses'])('can still fail over before model output on %s', async (path) => {
    routeRequest.mockReturnValueOnce(fakeRoute({ async *streamChatCompletion() { await wait(); throw Object.assign(new Error('too many requests'), { status: 429 }); } }, 1));
    routeRequest.mockReturnValue(fakeRoute({ async *streamChatCompletion() { yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model-2', choices: [{ index: 0, delta: { content: 'recovered' }, finish_reason: null }] }; yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }; } }, 2));
    const result = await request(path);
    expect(routeRequest.mock.calls.length).toBe(2); expect(result.status).toBe(200);
    expect(result.text).toContain(': upstream pending'); expect(result.text).toContain('recovered');
    expect(result.text).not.toContain('headers already sent'); expect(result.text).not.toContain('response.failed');
  });
  it('keeps fast/non-stream and other clients HTTP failures unchanged', async () => {
    const provider = { async chatCompletion() { throw Object.assign(new Error('test fatal rejection'), { status: 418 }); }, async *streamChatCompletion() { await wait(); throw Object.assign(new Error('test fatal rejection'), { status: 418 }); } };
    routeRequest.mockReturnValue(fakeRoute(provider));
    expect((await request('/v1/chat/completions', false)).status).toBe(502);
    routeRequest.mockReturnValue(fakeRoute(provider));
    const normal = await request('/v1/chat/completions', true, 'OtherClient');
    expect(normal.status).toBe(502); expect(normal.text).not.toContain('upstream pending');
  });
});
