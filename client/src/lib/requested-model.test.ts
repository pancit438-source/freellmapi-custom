import { describe, expect, it } from 'vitest'
import { isRequestedModelFallback } from './requested-model'

describe('requested model fallback display', () => {
  it('uses the routing identity for a shortened canonical Nemotron name', () => {
    expect(isRequestedModelFallback('nemotron-3-ultra-550b', 'nvidia/nemotron-3-ultra-550b-a55b', 'nvidia', true)).toBe(false)
  })
  it('retains a confirmed model fallback even if the basenames match', () => {
    expect(isRequestedModelFallback('gemma-4-26b-a4b-it', '@cf/google/gemma-4-26b-a4b-it', 'cloudflare', false)).toBe(true)
  })
  it.each([
    ['glm-5.3', 'z-ai/glm-5.3', 'nvidia', false],
    ['glm-5.3-flash', 'z-ai/glm-5.3-flash', 'nvidia', false],
    ['nvidia:z-ai/glm-5.3', 'z-ai/glm-5.3', 'nvidia', false],
    ['nvidia:glm-5.3', 'z-ai/glm-5.3', 'nvidia', false],
    ['z-ai/glm-5.3', 'z-ai/glm-5.3', 'nvidia', false],
    ['deepseek-flash', 'deepseek-flash', 'custom', false],
    ['glm-5.3', 'z-ai/glm-5.3-flash', 'nvidia', true],
    ['glm-5.3', 'moonshotai/kimi-k3', 'nvidia', true],
    ['other:glm-5.3', 'z-ai/glm-5.3', 'nvidia', true],
    ['other/glm-5.3', 'z-ai/glm-5.3', 'nvidia', true],
    ['auto:Default', 'z-ai/glm-5.3', 'nvidia', false],
    [null, 'z-ai/glm-5.3', 'nvidia', false],
  ])('%s served by %s on %s', (requested, served, platform, fallback) => {
    expect(isRequestedModelFallback(requested, served, platform)).toBe(fallback)
  })
})
