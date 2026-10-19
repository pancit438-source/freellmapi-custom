import { type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { type QuotaObservationContext } from '../services/provider-quota.js';
export declare const TYPHOON_BASE_URL = "https://api.opentyphoon.ai/v1";
/** Ongoing free, rate-limited research API, not a monthly credit grant.
 * Model rows arrive only through the signed catalog; OCR is not included.
 * https://docs.opentyphoon.ai/en/faq/ */
export declare class TyphoonProvider extends OpenAICompatProvider {
    constructor();
    validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult>;
}
//# sourceMappingURL=typhoon.d.ts.map