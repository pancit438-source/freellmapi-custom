# FreellmAPI LA Custom

This is the LA deployment's customized source release.

- Upstream baseline: `ffef850fe8553b03f89e2f76be4cb4da2b709378` from `https://github.com/tashfeenahmed/freellmapi.git`
- Adds average output token throughput (`词元/秒`, tokens per second) to the analytics model breakdown and the corresponding `/api/analytics/by-model` response field.
- Runtime data, environment files, databases, encryption keys, and secrets are intentionally excluded from this repository.

The checked-in `client/dist` and `server/dist` directories are prebuilt artifacts used by the deployment.
