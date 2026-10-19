import type { Response } from 'express';
export declare function isCodexClient(userAgent: string | undefined): boolean;
/** HTTP/SSE liveness is separate from the first model output. A comment keeps
 * a waiting bridge connected without claiming a completed turn or committing
 * the provider retry loop. Fast failures retain their original HTTP status. */
export declare function startCodexPendingStream(res: Response, enabled: boolean, delayMs?: number): void;
/** A failure after liveness headers must be an error frame, never JSON on an
 * SSE stream and never a synthetic successful completion. */
export declare function sendCodexStreamError(res: Response, status: number, body: Record<string, unknown>, wire: 'chat' | 'responses', responseId?: string): void;
/** A Chat bridge cannot execute the provider-hosted Responses search tool.
 * Its empty function schema used to create completed, query-less search items
 * in Codex. Keep ordinary client search functions with real arguments. */
export declare function removeHostedCodexSearch<T extends Record<string, unknown>>(tools: T[] | undefined, userAgent: string | undefined): T[] | undefined;
//# sourceMappingURL=codex-stream-transport.d.ts.map