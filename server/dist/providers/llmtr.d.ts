import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { type CompletionOptions, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { type QuotaObservationContext } from '../services/provider-quota.js';
export declare const LLMTR_BASE_URL = "https://llmtr.com/v1";
/**
 * Floor between the START of two key-validation probes (#1369).
 *
 * NOT a published LLMTR rate limit — their docs state none for this endpoint.
 * It is the politeness floor for OUR probe traffic: the same nonexistent-model
 * POST, repeated back to back from one IP, is the burst pattern their security
 * system reads as automation, and an account flagged that way gets suspended.
 * Every caller of validateKey reaches the network through this one method, so
 * pacing here covers the health pass, the forced pass behind the dashboard's
 * "check all" button, the post-wake re-probe, the cooldown-probe job and the
 * 401-triggered revalidation alike. Operators who know their account tolerates
 * more can lower it; 0 disables pacing.
 */
export declare const LLMTR_VALIDATION_MIN_GAP_MS = 2000;
export declare const LLMTR_VALIDATION_GAP_ENV = "LLMTR_VALIDATION_MIN_GAP_MS";
export interface LlmtrProviderOptions {
    /** Override the probe pacing floor. 0 disables it. */
    validationMinGapMs?: number;
    /** Test seams: injectable clock and sleep, so a pacing test needs no real
     *  timers and no wall-clock time. */
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}
/** Selected zero-priced routes have renewable daily/rolling quotas, not a
 * monthly cash grant. Only the signed catalog supplies model rows: the public
 * roster also contains paid models, expiring promotions and BYOK-only rows. */
export declare class LlmtrProvider extends OpenAICompatProvider {
    private readonly validationMinGapMs;
    private readonly now;
    private readonly sleep;
    /** Tail of the probe queue. Resolves when the probe ahead of a caller is
     * done, so validation requests run one at a time, in arrival order. */
    private validationTail;
    /** Start time of the last probe that got its turn, for the gap floor. */
    private lastValidationStartedAtMs;
    /** Probes already in flight, keyed by credential. Two callers asking about
     *  the same key at the same time (the health pass and the cooldown-probe job
     *  overlap easily) share one request instead of sending two identical ones. */
    private readonly inFlightValidations;
    constructor(opts?: LlmtrProviderOptions);
    /**
     * validateKey, paced and coalesced. Returns the same promise to concurrent
     * callers asking about the same credential, so the shared verdict is the one
     * question answered once. The merged callers' quota contexts are not
     * summed — quota observations are booked per platform+key, and a single
     * response carries a single set of headers to book.
     */
    validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult>;
    private retireValidation;
    /**
     * Take a turn in the probe queue: wait for the probe ahead, then for the gap
     * floor to elapse, then stamp the start and run. The queue is released in a
     * finally so a rejected probe (timeout, 5xx) cannot stall the probes behind
     * it for the rest of the process's life.
     */
    private queuedValidation;
    /** The probe itself: one authenticated request, verdict classified below. */
    private probeKey;
    chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse>;
    streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk>;
}
//# sourceMappingURL=llmtr.d.ts.map