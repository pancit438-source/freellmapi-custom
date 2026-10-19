import { getDb } from '../db/index.js';
/** Identify this deployment's independent SenseNova custom credentials. */
export function sensenovaCustomEndpoint(platform, keyId) {
    if (platform !== 'custom')
        return null;
    try {
        const row = getDb().prepare('SELECT base_url, label FROM api_keys WHERE id = ?').get(keyId);
        const isSense = row?.base_url?.includes('token.sensenova.cn') === true
            || row?.label?.toLowerCase().startsWith('sensenova-') === true;
        return isSense ? row?.base_url?.trim().replace(/\/+$/, '') || `sensenova-key:${keyId}` : null;
    }
    catch {
        return null;
    }
}
export function isSensenovaCustomKey(platform, keyId) {
    return sensenovaCustomEndpoint(platform, keyId) !== null;
}
/** Recent inference reliability, kept separate for small and large requests.
 *  A tiny successful check cannot erase repeated large-prompt 429s. These are
 *  routing preferences, not claimed upstream limits or additional cooldowns. */
export function sensenovaRateLimitRisk(modelId, keyId, estimatedTokens) {
    const large = estimatedTokens >= 50_000;
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    try {
        const sample = getDb().prepare(`
      SELECT COUNT(*) AS samples,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS limited
      FROM requests
      WHERE platform = 'custom' AND model_id = ? AND key_id = ? AND created_at >= ?
        AND ((status = 'success' AND input_tokens >= ? AND input_tokens < ?)
          OR (status = 'error' AND error LIKE '%API error 429:%' AND input_tokens < ?))
    `).get(modelId, keyId, cutoff, large ? 50_000 : 0, large ? Number.MAX_SAFE_INTEGER : 50_000, large ? Number.MAX_SAFE_INTEGER : 50_000);
        return sample.samples > 0 ? (sample.limited ?? 0) / sample.samples : 0;
    }
    catch {
        return 0;
    }
}
/** An endpoint-specific gate, independent of other custom providers. */
export function sensenovaConcurrencyLimit() {
    const raw = process.env.SENSENOVA_MAX_CONCURRENT_REQUESTS_PER_KEY;
    if (raw !== undefined && raw.trim() !== '') {
        const value = Number(raw);
        if (Number.isInteger(value) && value >= 0)
            return value === 0 ? null : value;
    }
    return 1;
}
//# sourceMappingURL=sensenova-policy.js.map