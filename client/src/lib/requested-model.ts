// A public slug and the provider's namespaced id can name the same model.
// Explicit platform pins and namespaced ids still require an exact match.
export function isRequestedModelFallback(requested: string | null, served: string, platform: string, honored?: boolean | null): boolean {
  if (!requested || requested === 'auto' || requested.startsWith('auto:')) return false
  if (typeof honored === 'boolean') return !honored
  let model = requested
  const separator = model.indexOf(':')
  if (separator >= 0) {
    if (model.slice(0, separator) !== platform) return true
    model = model.slice(separator + 1)
  }
  if (model === served) return false
  if (model.includes('/')) return true
  return model !== served.slice(served.lastIndexOf('/') + 1)
}
