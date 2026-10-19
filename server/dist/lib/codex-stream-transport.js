export function isCodexClient(userAgent) {
    return /codex desktop|codexplusplus\/protocolproxy/i.test(userAgent ?? '');
}
/** HTTP/SSE liveness is separate from the first model output. A comment keeps
 * a waiting bridge connected without claiming a completed turn or committing
 * the provider retry loop. Fast failures retain their original HTTP status. */
export function startCodexPendingStream(res, enabled, delayMs = 15_000) {
    if (!enabled)
        return;
    let heartbeat;
    const stop = () => {
        clearTimeout(pending);
        if (heartbeat)
            clearInterval(heartbeat);
        res.removeListener('finish', stop);
        res.removeListener('close', stop);
    };
    const pending = setTimeout(() => {
        if (res.destroyed || res.writableEnded || res.headersSent) {
            stop();
            return;
        }
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-FreeLLM-Stream-Pending', '1');
        res.flushHeaders();
        res.write(': upstream pending\n\n');
        heartbeat = setInterval(() => {
            if (res.destroyed || res.writableEnded)
                stop();
            else
                res.write(': keepalive\n\n');
        }, 15_000);
        heartbeat.unref?.();
    }, delayMs);
    pending.unref?.();
    res.once('finish', stop);
    res.once('close', stop);
}
/** A failure after liveness headers must be an error frame, never JSON on an
 * SSE stream and never a synthetic successful completion. */
export function sendCodexStreamError(res, status, body, wire, responseId) {
    if (!res.headersSent) {
        res.status(status).json(body);
        return;
    }
    const details = body.error !== null && typeof body.error === 'object' ? body.error : {};
    const error = { ...details, http_status: status };
    if (wire === 'chat') {
        res.write(`data: ${JSON.stringify({ ...body, error })}\n\ndata: [DONE]\n\n`);
    }
    else {
        const response = { id: responseId, object: 'response', status: 'failed', error };
        res.write(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', sequence_number: 0, response })}\n\n`);
    }
    res.end();
}
/** A Chat bridge cannot execute the provider-hosted Responses search tool.
 * Its empty function schema used to create completed, query-less search items
 * in Codex. Keep ordinary client search functions with real arguments. */
export function removeHostedCodexSearch(tools, userAgent) {
    if (!tools || !isCodexClient(userAgent))
        return tools;
    return tools.filter(tool => {
        if (tool.type === 'web_search' || tool.type === 'web_search_preview')
            return false;
        if (!tool.function || typeof tool.function !== 'object')
            return true;
        const fn = tool.function;
        if (typeof fn.name !== 'string' || !['web_search', 'web_search_preview'].includes(fn.name))
            return true;
        const parameters = fn.parameters !== null && typeof fn.parameters === 'object' ? fn.parameters : {};
        const properties = parameters.properties;
        return properties != null && typeof properties === 'object' && Object.keys(properties).length > 0;
    });
}
//# sourceMappingURL=codex-stream-transport.js.map