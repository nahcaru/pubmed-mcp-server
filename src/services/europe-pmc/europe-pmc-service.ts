/**
 * @fileoverview Europe PMC service. Wraps the EPMC REST API with rate-limiting,
 * retries, and JATS XML parsing. Two methods: `search()` for keyword discovery
 * across the EPMC corpus (MED/PMC/PPR/PAT/AGR) and `fullTextXml()` for fetching
 * a record's full-text JATS. The XML parser matches NCBI's ordered config so
 * `parsePmcArticle` consumes the result without modification.
 *
 * Optional service: only constructed when `EUROPEPMC_ENABLED=true` (the
 * default). `getEuropePmcService()` returns `undefined` when disabled so
 * callers can skip the chain step gracefully.
 *
 * @module src/services/europe-pmc/europe-pmc-service
 */

import {
  internalError,
  JsonRpcErrorCode,
  McpError,
  serializationError,
} from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { getServerConfig } from '@/config/server-config.js';
import { recoveryFor } from '@/services/error-contracts.js';
import type { JatsNode, JatsNodeList } from '@/services/ncbi/parsing/pmc-xml-helpers.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
import { EuropePmcApiClient } from './api-client.js';
import { EuropePmcRequestQueue } from './request-queue.js';
import type {
  EuropePmcFullTextResult,
  EuropePmcSearchHit,
  EuropePmcSearchParams,
  EuropePmcSearchResponse,
  EuropePmcSearchResult,
  EuropePmcSource,
} from './types.js';

/** Retryable transient codes — same set NCBI uses. */
const RETRYABLE_CODES = new Set<JsonRpcErrorCode>([
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.Timeout,
  JsonRpcErrorCode.RateLimited,
]);

const MAX_BACKOFF_MS = 30_000;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Facade over the Europe PMC REST API. Two methods:
 *   - `search()` — keyword search across MED/PMC/PPR/PAT/AGR.
 *   - `fullTextXml()` — JATS full text for an EPMC record.
 *
 * Both honor `ctx.signal` for cancellation and retry transient failures with
 * capped exponential backoff plus jitter.
 */
export class EuropePmcService {
  private readonly orderedXmlParser: XMLParser;

  constructor(
    private readonly client: EuropePmcApiClient,
    private readonly queue: EuropePmcRequestQueue,
    private readonly maxRetries: number,
  ) {
    /**
     * EPMC's fullTextXML is JATS Z39.96 — same DTD PMC uses — so the parser
     * config mirrors `NcbiResponseHandler.orderedXmlParser`. `preserveOrder`
     * keeps inline mixed content readable; `trimValues: false` retains spaces
     * between text and inline children.
     */
    this.orderedXmlParser = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: true,
      trimValues: false,
      processEntities: true,
      htmlEntities: true,
    });
  }

  /**
   * Search Europe PMC. Cursor-based pagination — pass `cursorMark: '*'` (or
   * omit) for the first page; pass the returned `nextCursorMark` for the next.
   */
  async search(params: EuropePmcSearchParams): Promise<EuropePmcSearchResult> {
    const text = await this.queue.enqueue(
      () => this.withRetry(() => this.client.search(params), 'search', params.signal),
      'search',
      params.signal,
    );

    let parsed: EuropePmcSearchResponse;
    try {
      parsed = JSON.parse(text) as EuropePmcSearchResponse;
    } catch (error: unknown) {
      throw serializationError(
        'Failed to parse Europe PMC search JSON response.',
        {
          reason: 'europepmc_invalid_response',
          responseSnippet: text.substring(0, 200),
          ...recoveryFor('europepmc_invalid_response'),
        },
        { cause: error },
      );
    }

    const hits = ensureArray<EuropePmcSearchHit>(parsed.resultList?.result);
    const echoed = parsed.request?.queryString ?? params.query;

    // EPMC echoes back the input cursor mark on the final page, so absence of
    // an explicit "next" or equality with the request's cursor marks the end.
    const cursorMark = parsed.request?.cursorMark ?? params.cursorMark ?? '*';
    const nextCursor =
      parsed.nextCursorMark && parsed.nextCursorMark !== cursorMark
        ? parsed.nextCursorMark
        : undefined;

    return {
      hits,
      hitCount: parsed.hitCount ?? hits.length,
      ...(nextCursor && { nextCursorMark: nextCursor }),
      cursorMark,
      query: echoed,
    };
  }

  /**
   * Fetch the JATS full text for an EPMC record. Returns:
   *   - `{ kind: 'found', xml, epmcId, source }` — JATS XML string usable
   *     directly by tool callers that hold their own parser, or via
   *     `parseFullTextXml()` for the parsed tree.
   *   - `{ kind: 'not-available', reason }` — EPMC has the record but
   *     publishes no fullTextXML (404 or empty body).
   */
  async fullTextXml(
    epmcId: string,
    source: EuropePmcSource,
    signal?: AbortSignal,
  ): Promise<EuropePmcFullTextResult> {
    const outcome = await this.queue.enqueue(
      () =>
        this.withRetry(
          () => this.client.fullTextXml(epmcId, signal),
          `fullTextXml(${epmcId})`,
          signal,
        ),
      `fullTextXml(${epmcId})`,
      signal,
    );

    if (outcome.kind === 'not-available') {
      return { kind: 'not-available', reason: outcome.reason };
    }
    return { kind: 'found', xml: outcome.xml, epmcId, source };
  }

  /**
   * Parse a JATS XML string into the ordered node tree consumed by
   * `parsePmcArticle`. Returns the `<article>` JatsNode, or `undefined` when
   * the body doesn't contain an article element (malformed / empty).
   *
   * Throws `SerializationError` only for fundamentally invalid XML; an
   * article-free but well-formed body returns `undefined` so callers can
   * surface a `no-epmc-fulltext` outcome without a hard failure.
   */
  parseFullTextXml(xml: string): JatsNode | undefined {
    const validationResult = XMLValidator.validate(xml.replace(/<!DOCTYPE[^>]*>/gi, ''));
    if (validationResult !== true) {
      throw serializationError('Received invalid XML from Europe PMC.', {
        reason: 'europepmc_invalid_response',
        responseSnippet: xml.substring(0, 200),
        ...recoveryFor('europepmc_invalid_response'),
      });
    }

    let parsed: unknown;
    try {
      parsed = this.orderedXmlParser.parse(xml);
    } catch (error: unknown) {
      const parserError = error instanceof Error ? error.message : String(error);
      throw serializationError(
        `Failed to parse Europe PMC fullTextXML response: ${parserError}`,
        {
          reason: 'europepmc_invalid_response',
          parserError,
          responseSnippet: xml.substring(0, 200),
          ...recoveryFor('europepmc_invalid_response'),
        },
        { cause: error },
      );
    }

    if (!Array.isArray(parsed)) return;
    const nodes = parsed as JatsNodeList;
    return nodes.find((n) => 'article' in n);
  }

  /**
   * Retry wrapper for transient errors. Mirrors NCBI's `withRetry` minus the
   * service-level deadline — EPMC requests are cheaper individually and the
   * caller (typically `ctx.signal`) bounds the total chain.
   */
  private async withRetry<T>(
    execute: () => Promise<T>,
    label: string,
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) throw signal.reason;

      try {
        return await execute();
      } catch (error: unknown) {
        if (signal?.aborted) throw signal.reason;
        if (!(error instanceof McpError)) throw error;
        if (!RETRYABLE_CODES.has(error.code)) throw error;

        if (attempt < this.maxRetries) {
          const baseDelay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
          const jitter = baseDelay * (0.75 + 0.5 * Math.random());
          const retryDelay = Math.round(jitter);
          logger.warning(
            `Europe PMC ${label} failed. Retrying (${attempt + 1}/${this.maxRetries}) in ${retryDelay}ms.`,
            requestContextService.createRequestContext({
              operation: 'EuropePmcRetry',
              label,
              attempt: attempt + 1,
              retryDelay,
            }),
          );
          await abortableSleep(retryDelay, signal);
          continue;
        }

        const attempts = this.maxRetries + 1;
        const msg = error instanceof Error ? error.message : String(error);
        throw new McpError(
          error.code,
          `${msg} (failed after ${attempts} attempts)`,
          {
            reason: 'europepmc_unreachable',
            label,
            attempts,
            ...recoveryFor('europepmc_unreachable'),
          },
          { cause: error },
        );
      }
    }

    throw internalError('Europe PMC request failed after all retries.', {
      reason: 'europepmc_unreachable',
      label,
      ...recoveryFor('europepmc_unreachable'),
    });
  }
}

// ─── Init / Accessor ────────────────────────────────────────────────────────

let _service: EuropePmcService | undefined;

/**
 * Initialize the Europe PMC service when enabled. Safe to call regardless of
 * config — `EUROPEPMC_ENABLED=false` leaves the service unset so callers see
 * `undefined` and skip the chain step.
 */
export function initEuropePmcService(): void {
  const config = getServerConfig();
  if (!config.europepmcEnabled) {
    logger.info('Europe PMC service disabled (EUROPEPMC_ENABLED=false).');
    return;
  }

  const client = new EuropePmcApiClient({
    timeoutMs: config.europepmcTimeoutMs,
    ...(config.europepmcEmail && { email: config.europepmcEmail }),
  });
  const queue = new EuropePmcRequestQueue(config.europepmcRequestDelayMs);
  _service = new EuropePmcService(client, queue, config.europepmcMaxRetries);
  logger.info(
    'Europe PMC service initialized.',
    requestContextService.createRequestContext({
      operation: 'EuropePmcInit',
      requestDelayMs: config.europepmcRequestDelayMs,
      maxRetries: config.europepmcMaxRetries,
      timeoutMs: config.europepmcTimeoutMs,
      hasEmail: !!config.europepmcEmail,
    }),
  );
}

/** Returns the initialized service, or `undefined` when EPMC is disabled. */
export function getEuropePmcService(): EuropePmcService | undefined {
  return _service;
}
