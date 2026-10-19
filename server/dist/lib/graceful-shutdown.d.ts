import type { Server } from 'node:http';
/**
 * In a container the server is PID 1, and PID 1 gets no default action for
 * SIGTERM: without a handler `docker stop` — and every Watchtower self-update —
 * waits out its timeout and SIGKILLs the process mid-write. This stops taking
 * connections, lets in-flight requests finish, closes the database cleanly and
 * exits; a stuck request cannot hold the process past `graceMs`.
 */
export declare function installGracefulShutdown(options: {
    servers: () => Server[];
    closeDb: () => void;
    graceMs?: number;
    proc?: Pick<NodeJS.Process, 'once' | 'exit'>;
    logger?: Pick<Console, 'log' | 'error'>;
}): void;
//# sourceMappingURL=graceful-shutdown.d.ts.map