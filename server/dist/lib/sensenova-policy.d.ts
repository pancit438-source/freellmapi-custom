/** Identify this deployment's independent SenseNova custom credentials. */
export declare function sensenovaCustomEndpoint(platform: string, keyId: number): string | null;
export declare function isSensenovaCustomKey(platform: string, keyId: number): boolean;
/** Recent inference reliability, kept separate for small and large requests.
 *  A tiny successful check cannot erase repeated large-prompt 429s. These are
 *  routing preferences, not claimed upstream limits or additional cooldowns. */
export declare function sensenovaRateLimitRisk(modelId: string, keyId: number, estimatedTokens: number): number;
/** An endpoint-specific gate, independent of other custom providers. */
export declare function sensenovaConcurrencyLimit(): number | null;
//# sourceMappingURL=sensenova-policy.d.ts.map