// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { focusManager, notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AnalyticsPage from './AnalyticsPage'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ apiFetch: fetchMock }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('recharts', () => {
  const childrenOnly = ({ children }: { children?: ReactNode }) => children
  return {
    BarChart: childrenOnly, Bar: () => null, XAxis: () => null, YAxis: () => null,
    CartesianGrid: () => null, Tooltip: () => null, ResponsiveContainer: childrenOnly,
    LineChart: childrenOnly, Line: () => null, Legend: () => null,
  }
})

const firstRow = {
  id: 1, platform: 'nvidia', modelId: 'record-one', requestedModel: null,
  requestType: 'chat', status: 'success', inputTokens: 20, outputTokens: 10,
  latencyMs: 1000, createdAt: '2026-01-01 00:00:00', clientIp: null,
  clientUserAgent: null, keyLabel: null, attemptCount: 1,
}
const secondRow = { ...firstRow, id: 2, modelId: 'record-two' }
const summary = {
  totalRequests: 1, successRate: 100, totalInputTokens: 20, totalOutputTokens: 10,
  avgLatencyMs: 1000, p50LatencyMs: 1000, p95LatencyMs: 1000, avgTtfbMs: 500,
  requestTypeCounts: { chat: 1, embedding: 0 }, estimatedCostSavings: 0,
  pinnedRequests: 0, pinHonoredRequests: 0, firstRequestAt: null, lifetimeTotalRequests: 1,
}

let host: HTMLDivElement
let root: Root
let client: QueryClient
let rows = [firstRow]
let holdRequests = false
let finishRequest: ((value: unknown) => void) | undefined

function requestCalls(): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter(url => url.startsWith('/api/analytics/requests?'))
}

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })
  await act(async () => { root.render(<QueryClientProvider client={client}><AnalyticsPage /></QueryClientProvider>) })
  await flush()
}

async function selectInterval(value: string) {
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="analytics.autoRefresh"]')!
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  // Flush query notifications within act without advancing the polling clock.
  notifyManager.setScheduler(callback => { void Promise.resolve().then(callback) })
  localStorage.clear()
  focusManager.setFocused(true)
  rows = [firstRow]
  holdRequests = false
  finishRequest = undefined
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/analytics/requests?')) {
      if (holdRequests) return new Promise(resolve => { finishRequest = resolve })
      return Promise.resolve({ total: rows.length, rows })
    }
    if (url.startsWith('/api/analytics/requests/')) {
      return Promise.resolve({ ...firstRow, error: null, ttfbMs: 500, attempts: [] })
    }
    if (url.startsWith('/api/analytics/summary?')) return Promise.resolve(summary)
    if (url === '/api/cache/stats') return Promise.resolve({ enabled: false })
    if (url.startsWith('/api/analytics/error-distribution?')) return Promise.resolve({ byCategory: [], byPlatform: [], detailed: [] })
    return Promise.resolve([])
  })
})

afterEach(async () => {
  holdRequests = false
  finishRequest?.({ total: 0, rows: [] })
  if (root) await act(async () => { root.unmount() })
  client?.clear()
  host?.remove()
  focusManager.setFocused(undefined)
  vi.clearAllTimers()
  vi.useRealTimers()
  notifyManager.setScheduler(callback => { setTimeout(callback, 0) })
})

describe('Analytics recent-call refresh', () => {
  it('ignores an unsafe stored interval instead of hammering the API', async () => {
    localStorage.setItem('analytics.refreshMs', '10')
    await mount()
    expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe('5000')
    await tick(4_999)
    expect(requestCalls()).toHaveLength(1)
    await tick(1)
    expect(requestCalls()).toHaveLength(2)
  })

  it('updates calls after five seconds and summaries on the slower cadence', async () => {
    await mount()
    expect(host.textContent).toContain('record-one')
    const summaryCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/analytics/summary?')).length
    const before = summaryCalls()
    rows = [secondRow, firstRow]
    await tick(5_000)
    expect(host.textContent).toContain('record-two')
    expect(requestCalls()).toHaveLength(2)
    expect(summaryCalls()).toBe(before)
    await tick(25_000)
    expect(summaryCalls()).toBeGreaterThan(before)
  })

  it('persists a pause and does not refresh paused data on time or focus', async () => {
    await mount()
    await selectInterval('0')
    expect(localStorage.getItem('analytics.refreshMs')).toBe('0')
    await act(async () => { root.unmount() })
    client.clear()
    host.remove()
    fetchMock.mockClear()
    await mount()
    expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe('0')
    await tick(60_000)
    await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true) })
    await flush()
    expect(requestCalls()).toHaveLength(1)
  })

  it('stops background polling and refreshes immediately on return while data is fresh', async () => {
    await mount()
    await act(async () => { focusManager.setFocused(false) })
    rows = [secondRow]
    await tick(1_000)
    expect(requestCalls()).toHaveLength(1)
    await act(async () => { focusManager.setFocused(true) })
    await flush()
    expect(host.textContent).toContain('record-two')
    expect(requestCalls()).toHaveLength(2)
    await act(async () => { focusManager.setFocused(false) })
    const count = fetchMock.mock.calls.length
    await tick(35_000)
    expect(fetchMock.mock.calls).toHaveLength(count)
  })

  it('keeps the selected status and time range across polling', async () => {
    localStorage.setItem('analytics.range', '24h')
    await mount()
    const errors = [...host.querySelectorAll('button')].find(button => button.textContent === 'analytics.errors')!
    await act(async () => { errors.click() })
    await flush()
    const count = requestCalls().length
    await tick(5_000)
    expect(requestCalls()).toHaveLength(count + 1)
    expect(requestCalls().at(-1)).toContain('status=error')
    expect(requestCalls().at(-1)).toContain('range=24h')
    expect(errors.getAttribute('aria-selected')).toBe('true')
  })

  it('holds the call list while reading earlier rows and resumes at the top', async () => {
    await mount()
    const list = host.querySelector<HTMLDivElement>('[class*="max-h-[420px]"]')!
    await act(async () => { list.scrollTop = 80; list.dispatchEvent(new Event('scroll', { bubbles: true })) })
    expect(host.textContent).toContain('analytics.refreshHeld')
    rows = [secondRow]
    await tick(10_000)
    expect(requestCalls()).toHaveLength(1)
    expect(host.textContent).toContain('record-one')
    await act(async () => { list.scrollTop = 0; list.dispatchEvent(new Event('scroll', { bubbles: true })) })
    await tick(5_000)
    expect(host.textContent).toContain('record-two')
  })

  it('avoids issuing another request while a slow poll is still in flight', async () => {
    await mount()
    holdRequests = true
    await tick(5_000)
    expect(requestCalls()).toHaveLength(2)
    await tick(10_000)
    expect(requestCalls()).toHaveLength(2)
    holdRequests = false
    await act(async () => { finishRequest!({ total: 1, rows: [secondRow] }) })
    await flush()
    expect(host.textContent).toContain('record-two')
  })

  it('allows a manual update while automatic refresh is paused', async () => {
    await mount()
    await selectInterval('0')
    rows = [secondRow]
    const refresh = [...host.querySelectorAll('button')].find(button => button.textContent === 'analytics.refreshNow')!
    await act(async () => { refresh.click() })
    await flush()
    expect(host.textContent).toContain('record-two')
    const count = requestCalls().length
    await tick(10_000)
    expect(requestCalls()).toHaveLength(count)
    expect(localStorage.getItem('analytics.refreshMs')).toBe('0')
  })
})
