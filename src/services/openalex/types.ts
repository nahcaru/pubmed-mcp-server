/**
 * @fileoverview Types for the OpenAlex API. Covers the work lookup (PMID resolve),
 * related/referenced works resolution, and cited-by filter endpoints.
 *
 * See https://docs.openalex.org/api-entities/works for the full API.
 * We use three endpoints:
 *   - GET /works/pmid:{pmid}?select=id,related_works,referenced_works
 *   - GET /works?filter=openalex:{id}|{id}&select=id,ids  (batch PMID resolve)
 *   - GET /works?filter=cites:{id}&select=id,ids  (cited_by)
 *
 * @module src/services/openalex/types
 */

/** Base URL for the OpenAlex public API. */
export const OPENALEX_API_BASE = 'https://api.openalex.org';

/**
 * Identifier block on an OpenAlex Work. Only `openalex` (the OA ID) is always
 * present; `pmid` is absent for non-PubMed records. We only care about PMIDs —
 * any record without one is dropped.
 */
export interface OpenAlexWorkIds {
  doi?: string;
  mag?: string;
  openalex?: string;
  pmid?: string;
  [key: string]: string | undefined;
}

/**
 * Minimal Work record — only fields the service actually uses. We use
 * `select=id,ids` on batch calls to keep responses small.
 */
export interface OpenAlexWork {
  /** OpenAlex canonical ID, e.g. "https://openalex.org/W2960163646". */
  id: string;
  ids?: OpenAlexWorkIds;
  /** IDs of referenced works (this work's reference list). Only present when requested. */
  referenced_works?: string[];
  /** IDs of related works (content-based similarity). Only present when requested. */
  related_works?: string[];
}

/** Top-level response shape from the /works collection endpoint. */
export interface OpenAlexWorksResponse {
  meta?: {
    count?: number;
    page?: number;
    per_page?: number;
    next_cursor?: string;
  };
  results?: OpenAlexWork[];
  [key: string]: unknown;
}

/** Resolved PMID list returned by service methods. */
export interface OpenAlexRelatedResult {
  pmids: string[];
  totalCount: number;
}
