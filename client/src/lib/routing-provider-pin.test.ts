import { describe, expect, it } from 'vitest'
import { providerPinId } from './routing'

describe('Provider-specific model identifiers', () => {
  it('pins NVIDIA instead of returning a bare id that can resolve to other channels', () => {
    expect(providerPinId({ platform: 'nvidia', modelId: 'deepseek-ai/deepseek-v4.1-flash' }, []))
      .toBe('nvidia:deepseek-ai/deepseek-v4.1-flash')
  })
  it('retains the endpoint binding even when only one custom endpoint is displayed', () => {
    const row = { platform: 'custom', modelId: 'deepseek-v4.1-flash', qualifiedModelId: 'custom:deepseek-v4.1-flash#sense-key-rap' }
    expect(providerPinId(row, [row])).toBe(row.qualifiedModelId)
  })
})
