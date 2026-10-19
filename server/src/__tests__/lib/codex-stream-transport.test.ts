import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCodexClient, removeHostedCodexSearch, sendCodexStreamError, startCodexPendingStream } from '../../lib/codex-stream-transport.js';

class FakeResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  statusCode = 200;
  headers = new Map<string, string>();
  frames: string[] = [];
  jsonBody: unknown;
  setHeader(name: string, value: string) {
    if (this.headersSent) throw new Error('headers already sent');
    this.headers.set(name, value);
  }
  flushHeaders() { this.headersSent = true; }
  write(frame: string) { this.frames.push(frame); return true; }
  status(code: number) { this.statusCode = code; return this; }
  json(body: unknown) { this.jsonBody = body; this.end(); return this; }
  end() { this.writableEnded = true; this.emit('finish'); }
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('Codex pending stream transport', () => {
  it('does not create liveness timers for other clients', () => {
    vi.useFakeTimers(); const res = new FakeResponse();
    startCodexPendingStream(res as any, false);
    expect(vi.getTimerCount()).toBe(0);
    expect(isCodexClient('curl/8')).toBe(false);
    expect(isCodexClient('Codex Desktop/0.162')).toBe(true);
  });
  it('returns headers and comments before a slow model, without output events', () => {
    vi.useFakeTimers(); const res = new FakeResponse();
    startCodexPendingStream(res as any, true);
    vi.advanceTimersByTime(14_999); expect(res.headersSent).toBe(false);
    vi.advanceTimersByTime(1); expect(res.headersSent).toBe(true);
    expect(res.frames).toEqual([': upstream pending\n\n']);
    vi.advanceTimersByTime(15_000);
    expect(res.frames[1]).toBe(': keepalive\n\n');
    expect(res.frames.join('')).not.toContain('response.completed');
    res.end(); expect(vi.getTimerCount()).toBe(0);
  });
  it('leaves a fast committed stream alone', () => {
    vi.useFakeTimers(); const res = new FakeResponse();
    startCodexPendingStream(res as any, true); res.flushHeaders();
    vi.advanceTimersByTime(20_000);
    expect(res.frames).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['finish', 'close'])('cleans timers on %s', (event) => {
    vi.useFakeTimers(); const res = new FakeResponse();
    startCodexPendingStream(res as any, true); vi.advanceTimersByTime(15_000);
    res.emit(event); expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves HTTP errors before headers', () => {
    const res = new FakeResponse(); const body = { error: { type: 'rate_limit_error', message: 'limited' } };
    sendCodexStreamError(res as any, 429, body, 'chat');
    expect(res.statusCode).toBe(429); expect(res.jsonBody).toBe(body); expect(res.frames).toHaveLength(0);
  });
  it('uses an in-band Chat error after liveness headers', () => {
    const res = new FakeResponse(); res.flushHeaders();
    sendCodexStreamError(res as any, 503, { error: { type: 'server_error', message: 'unavailable' } }, 'chat');
    expect(res.frames.join('')).toContain('"http_status":503');
    expect(res.frames.join('')).toContain('data: [DONE]');
    expect(res.frames.join('')).not.toContain('"choices"');
  });
  it('uses response.failed instead of completed after Responses liveness', () => {
    const res = new FakeResponse(); res.flushHeaders();
    sendCodexStreamError(res as any, 502, { error: { type: 'provider_error', message: 'failed' } }, 'responses', 'resp_test');
    expect(res.frames.join('')).toContain('event: response.failed');
    expect(res.frames.join('')).toContain('"id":"resp_test"');
    expect(res.frames.join('')).not.toContain('response.completed');
  });
  it('removes only unsupported hosted search and retains client functions', () => {
    const tools = [
      { type: 'web_search' },
      { type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'web_search', parameters: { properties: { query: { type: 'string' } } } } },
      { type: 'function', function: { name: 'read_file', parameters: {} } },
    ];
    expect(removeHostedCodexSearch(tools, 'Codex Desktop')).toEqual(tools.slice(2));
    expect(removeHostedCodexSearch(tools, 'curl')).toBe(tools);
  });
});
