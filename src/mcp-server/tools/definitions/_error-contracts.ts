/**
 * @fileoverview Shared `errors[]` contract entries for tool definitions.
 *
 * The NCBI service layer (queue, retry loop, deadline) throws three failure
 * modes that any NCBI-consuming tool can surface. They're collected here so
 * tool definitions can spread them into their own `errors[]` without
 * duplicating the contract — keeping the public failure surface consistent
 * and machine-readable across the whole server.
 *
 * Service-layer throws stamp `data.reason` to match these entries (see
 * `src/services/ncbi/request-queue.ts` and `src/services/ncbi/ncbi-service.ts`)
 * so wire payloads carry the same `error.data.reason` clients see from
 * `ctx.fail` in tool handlers.
 *
 * @module src/mcp-server/tools/definitions/_error-contracts
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

/**
 * Cross-tool error reasons shared by every tool that calls the NCBI service.
 * Spread these into a tool's `errors[]` alongside any tool-specific entries.
 */
export const NCBI_SERVICE_ERRORS = [
  {
    reason: 'queue_full',
    code: JsonRpcErrorCode.RateLimited,
    when: 'Local NCBI request queue is at capacity.',
    recovery: 'Retry after 1-2 seconds; the request queue hit the NCBI rate limit.',
    retryable: true,
  },
  {
    reason: 'ncbi_unreachable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'NCBI E-utilities is unreachable after all retry attempts.',
    recovery: 'Retry after a brief delay; NCBI was unreachable across all retry attempts.',
    retryable: true,
  },
  {
    reason: 'ncbi_deadline_exceeded',
    code: JsonRpcErrorCode.Timeout,
    when: 'Total request deadline expired before NCBI returned a response.',
    recovery: 'Reduce batch size or retry; NCBI may be under temporary load.',
    retryable: true,
  },
] as const;
