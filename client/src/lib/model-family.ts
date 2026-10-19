export type ModelFamily = 'all' | 'deepseek-v4' | 'deepseek-v3' | 'deepseek-r1' | 'deepseek-alias'

export function matchesModelFamily(members: readonly { modelId: string }[], family: ModelFamily): boolean {
  if (family === 'all') return true
  return members.some(({ modelId }) => {
    const id = modelId.toLowerCase()
    if (!id.includes('deepseek')) return false
    if (family === 'deepseek-v4') return /deepseek[-_]v4(?:[.\-_:]|$)/.test(id)
    if (family === 'deepseek-v3') return /deepseek[-_]v3(?:[.\-_:]|$)/.test(id)
    if (family === 'deepseek-r1') return /deepseek[-_]r1(?:[.\-_:]|$)/.test(id)
    return !/deepseek[-_](?:v\d|r\d)/.test(id)
  })
}
