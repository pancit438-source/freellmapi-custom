// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ModelDetailPage from './ModelDetailPage'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ apiFetch: fetchMock }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/copy-button', () => ({ CopyButton: () => null }))
vi.mock('@/components/model-table', () => ({
  ModelTableHead: () => null, RateLimitBadge: () => null, RowContent: () => <td />,
}))

let host: HTMLDivElement
let root: Root
let client: QueryClient
let globallyEnabled: boolean
let rejectPatch: boolean

const model = {
  modelDbId: 791, platform: 'custom', modelId: 'deepseek-v4.1-flash',
  displayName: 'DeepSeek V4.1 Flash (SenseNova)', canonicalId: 'deepseek-v4.1-flash',
  groupLabel: 'DeepSeek V4.1 Flash', groupKey: 'deepseek v4.1 flash', keyCount: 1,
  keyLabel: 'sensenova-test', source: 'custom', priority: 1,
  intelligenceRank: 50, speedRank: 50, sizeLabel: 'Large',
  rpmLimit: null, rpdLimit: null, monthlyTokenBudget: '', supportsTools: false, supportsVision: false,
}

async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

beforeEach(async () => {
  vi.stubGlobal('__SERVER_PORT__', 3002)
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  notifyManager.setScheduler(callback => { void Promise.resolve().then(callback) })
  globallyEnabled = true
  rejectPatch = false
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string, options?: { method?: string; body?: string }) => {
    if (url === '/api/fallback?includeDisabled=1') return [{ ...model, modelEnabled: globallyEnabled, enabled: false }]
    if (url === '/api/fallback/routing') return { strategy: 'priority', scores: [] }
    if (url === '/api/fallback/rate-limit-usage') return { rows: [] }
    if (url === '/api/settings/unify') return { enabled: true, overrides: { merges: [], splits: [] } }
    if (url === '/api/settings/api-key') return { apiKey: 'TEST_ONLY' }
    if (url === '/api/models/791' && options?.method === 'PATCH') {
      if (rejectPatch) throw new Error('Model update failed')
      globallyEnabled = JSON.parse(options.body!).enabled
      return { success: true }
    }
    throw new Error('Unexpected test API route')
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/models/chat/deepseek-v4.1-flash']}>
        <Routes><Route path="/models/chat/:id" element={<ModelDetailPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ))
  await flush()
})

afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
  host.remove()
  vi.unstubAllGlobals()
})

describe('Model detail global availability', () => {
  it('uses the native global patch and keeps disabled rows available to re-enable', async () => {
    const toggle = () => host.querySelector<HTMLButtonElement>('[aria-label="models.globalEnabled"]')!
    await act(async () => toggle().click())
    await flush()
    expect(fetchMock).toHaveBeenCalledWith('/api/models/791', { method: 'PATCH', body: '{"enabled":false}' })
    expect(host.textContent).toContain('models.globallyDisabled')
    expect(toggle()).not.toBeNull()
    await act(async () => toggle().click())
    await flush()
    expect(fetchMock).toHaveBeenCalledWith('/api/models/791', { method: 'PATCH', body: '{"enabled":true}' })
    expect(globallyEnabled).toBe(true)
  })

  it('reports a failed global update without hiding the still-enabled model', async () => {
    rejectPatch = true
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="models.globalEnabled"]')!.click())
    await flush()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Model update failed')
    expect(globallyEnabled).toBe(true)
    expect(host.textContent).not.toContain('models.globallyDisabled')
  })
})
