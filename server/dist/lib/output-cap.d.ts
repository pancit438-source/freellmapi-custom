export declare const MIN_LEARNED_OUTPUT_CAP = 1024;
/** The output ceiling a provider names when it rejects max_tokens as too
 *  large, or null when the error is anything else. Both the parameter name and
 *  a ceiling phrase must appear, so a context-window rejection that merely
 *  mentions "maximum output tokens" (Cloudflare) never matches. */
export declare function parseMaxTokensCeiling(message: unknown): number | null;
/** Learn the ceiling from a max_tokens rejection. Returns it, or null when the
 *  error is not one, or when the reading is below MIN_LEARNED_OUTPUT_CAP. The
 *  lowest reading wins. */
export declare function learnOutputCapFromError(route: {
    platform: string;
    modelId: string;
}, err: any): number | null;
export declare function learnedOutputCap(platform: string, modelId: string): number | undefined;
/** The output budget for one route: what is left of its context window after
 *  the input, lowered to any learned output ceiling. Adapters pass it to
 *  resolveMaxTokens as `contextBudget`. */
export declare function routeOutputBudget(route: {
    platform: string;
    modelId: string;
    contextWindow?: number | null;
}, estimatedInputTokens: number): number | undefined;
export declare function resetLearnedOutputCaps(): void;
//# sourceMappingURL=output-cap.d.ts.map