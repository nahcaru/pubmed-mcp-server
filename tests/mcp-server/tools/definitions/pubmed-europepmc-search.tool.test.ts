/**
 * @fileoverview Tests for the Europe PMC search tool.
 * @module tests/mcp-server/tools/definitions/pubmed-europepmc-search.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSearch = vi.fn();
const mockGetEpmc = vi.fn();

vi.mock('@/services/europe-pmc/europe-pmc-service.js', () => ({
  getEuropePmcService: () => mockGetEpmc(),
}));

const { pubmedEuropepmcSearchTool } = await import(
  '@/mcp-server/tools/definitions/pubmed-europepmc-search.tool.js'
);

describe('pubmedEuropepmcSearchTool', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ search: mockSearch });
  });

  it('parses valid input with defaults', () => {
    const input = pubmedEuropepmcSearchTool.input.parse({ query: 'cancer' });
    expect(input.query).toBe('cancer');
    expect(input.pageSize).toBe(25);
    expect(input.cursorMark).toBe('*');
    expect(input.resultType).toBe('core');
    expect(input.sources).toBeUndefined();
  });

  it('rejects empty query', () => {
    const parsed = pubmedEuropepmcSearchTool.input.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects pageSize beyond 100', () => {
    const parsed = pubmedEuropepmcSearchTool.input.safeParse({ query: 'foo', pageSize: 200 });
    expect(parsed.success).toBe(false);
  });

  it('accepts explicit sources including PAT and AGR', () => {
    const input = pubmedEuropepmcSearchTool.input.parse({
      query: 'foo',
      sources: ['MED', 'PMC', 'PPR', 'PAT', 'AGR'],
    });
    expect(input.sources).toEqual(['MED', 'PMC', 'PPR', 'PAT', 'AGR']);
  });

  it('throws with reason europepmc_disabled when EPMC service is unavailable', async () => {
    mockGetEpmc.mockReturnValue(undefined);
    const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
    const input = pubmedEuropepmcSearchTool.input.parse({ query: 'foo' });
    const promise = pubmedEuropepmcSearchTool.handler(input, ctx);
    await expect(promise).rejects.toThrow(/EUROPEPMC_ENABLED|service is not available/i);
    await expect(promise).rejects.toMatchObject({
      data: { reason: 'europepmc_disabled' },
    });
  });

  it('passes default sources (MED, PMC, PPR) when none provided', async () => {
    mockSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
    const ctx = createMockContext();
    const input = pubmedEuropepmcSearchTool.input.parse({ query: 'foo' });
    await pubmedEuropepmcSearchTool.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ sources: ['MED', 'PMC', 'PPR'] }),
    );
  });

  it('passes through explicit sources', async () => {
    mockSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
    const ctx = createMockContext();
    const input = pubmedEuropepmcSearchTool.input.parse({
      query: 'foo',
      sources: ['PPR', 'PAT'],
    });
    await pubmedEuropepmcSearchTool.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ sources: ['PPR', 'PAT'] }));
  });

  it('passes cursorMark through and reports nextCursorMark when present', async () => {
    mockSearch.mockResolvedValue({
      hits: [{ id: '1', source: 'MED', title: 'A', pmid: '1' }],
      hitCount: 50,
      cursorMark: '*',
      nextCursorMark: 'CURSOR_NEXT',
      query: 'foo',
    });
    const ctx = createMockContext();
    const input = pubmedEuropepmcSearchTool.input.parse({ query: 'foo' });
    const result = await pubmedEuropepmcSearchTool.handler(input, ctx);
    expect(result.cursorMark).toBe('*');
    expect(result.nextCursorMark).toBe('CURSOR_NEXT');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.epmcId).toBe('1');
  });

  it('flattens EPMC `Y`/`N` flags into booleans (isOpenAccess, hasFullTextXml)', async () => {
    mockSearch.mockResolvedValue({
      hits: [{ id: '2', source: 'PPR', title: 'preprint', isOpenAccess: 'Y', inPMC: 'N' }],
      hitCount: 1,
      cursorMark: '*',
      query: 'foo',
    });
    const ctx = createMockContext();
    const input = pubmedEuropepmcSearchTool.input.parse({ query: 'preprint' });
    const result = await pubmedEuropepmcSearchTool.handler(input, ctx);
    expect(result.hits[0]?.isOpenAccess).toBe(true);
    expect(result.hits[0]?.hasFullTextXml).toBe(false);
  });

  it('truncates long abstracts and emits a notice when no hits returned', async () => {
    const longAbstract = 'a'.repeat(900);
    mockSearch.mockResolvedValueOnce({
      hits: [{ id: '3', source: 'MED', title: 'long', abstractText: longAbstract }],
      hitCount: 1,
      cursorMark: '*',
      query: 'foo',
    });
    const ctx = createMockContext();
    const result1 = await pubmedEuropepmcSearchTool.handler(
      pubmedEuropepmcSearchTool.input.parse({ query: 'foo' }),
      ctx,
    );
    expect(result1.hits[0]?.abstractSnippet).toBeDefined();
    expect(result1.hits[0]?.abstractSnippet?.length).toBeLessThanOrEqual(401);
    expect(result1.hits[0]?.abstractSnippet?.endsWith('…')).toBe(true);

    mockSearch.mockResolvedValueOnce({ hits: [], hitCount: 0, cursorMark: '*', query: 'foo' });
    await pubmedEuropepmcSearchTool.handler(
      pubmedEuropepmcSearchTool.input.parse({ query: 'no matches' }),
      ctx,
    );
    expect(getEnrichment(ctx).notice).toMatch(/No results/);
  });

  it('emits an epmcUrl per hit', async () => {
    mockSearch.mockResolvedValue({
      hits: [{ id: 'PPR9', source: 'PPR' }],
      hitCount: 1,
      cursorMark: '*',
      query: 'foo',
    });
    const ctx = createMockContext();
    const result = await pubmedEuropepmcSearchTool.handler(
      pubmedEuropepmcSearchTool.input.parse({ query: 'foo' }),
      ctx,
    );
    expect(result.hits[0]?.epmcUrl).toBe('https://europepmc.org/article/PPR/PPR9');
  });

  describe('PPR date-sort advisory (issue #67)', () => {
    const pprHit = { id: 'PPR1', source: 'PPR', firstPublicationDate: '2026-03-13' };

    it('advises when P_PDATE_D sort is requested for a PPR-only result set', async () => {
      mockSearch.mockResolvedValue({ hits: [pprHit], hitCount: 5, cursorMark: '*', query: 'q' });
      const ctx = createMockContext();
      await pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({
          query: 'q',
          sources: ['PPR'],
          sort: 'P_PDATE_D desc',
        }),
        ctx,
      );
      const notice = getEnrichment(ctx).notice ?? '';
      expect(notice).toContain('P_PDATE_D');
      expect(notice).toContain('PPR');
      expect(notice).toContain('PUB_YEAR');
      expect(notice).toContain('firstPublicationDate');
    });

    it('is case-insensitive on the sort field token', async () => {
      mockSearch.mockResolvedValue({ hits: [pprHit], hitCount: 5, cursorMark: '*', query: 'q' });
      const ctx = createMockContext();
      await pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({
          query: 'q',
          sources: ['PPR'],
          sort: 'p_pdate_d asc',
        }),
        ctx,
      );
      expect(getEnrichment(ctx).notice).toContain('P_PDATE_D');
    });

    it('does NOT advise when the result set spans non-PPR sources', async () => {
      mockSearch.mockResolvedValue({ hits: [pprHit], hitCount: 5, cursorMark: '*', query: 'q' });
      const ctx = createMockContext();
      // Default sources (MED, PMC, PPR) — not PPR-only.
      await pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({ query: 'q', sort: 'P_PDATE_D desc' }),
        ctx,
      );
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('does NOT advise for PUB_YEAR sort on PPR-only (EPMC honors it)', async () => {
      mockSearch.mockResolvedValue({ hits: [pprHit], hitCount: 5, cursorMark: '*', query: 'q' });
      const ctx = createMockContext();
      await pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({
          query: 'q',
          sources: ['PPR'],
          sort: 'PUB_YEAR desc',
        }),
        ctx,
      );
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('does NOT advise for PPR-only without a sort', async () => {
      mockSearch.mockResolvedValue({ hits: [pprHit], hitCount: 5, cursorMark: '*', query: 'q' });
      const ctx = createMockContext();
      await pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({ query: 'q', sources: ['PPR'] }),
        ctx,
      );
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('empty-result notice takes precedence over the date-sort advisory', async () => {
      mockSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*', query: 'q' });
      const ctx = createMockContext();
      await pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({
          query: 'q',
          sources: ['PPR'],
          sort: 'P_PDATE_D desc',
        }),
        ctx,
      );
      expect(getEnrichment(ctx).notice).toMatch(/No results/);
    });
  });

  describe('format()', () => {
    it('renders hits with all key fields', () => {
      const blocks = pubmedEuropepmcSearchTool.format!({
        hits: [
          {
            source: 'MED',
            epmcId: '42',
            title: 'Title',
            authors: 'Smith J, Jones K',
            journal: 'Nature',
            pubYear: '2024',
            firstPublicationDate: '2024-03-15',
            pmid: '42',
            pmcId: 'PMC9',
            doi: '10.1/x',
            isOpenAccess: true,
            hasFullTextXml: true,
            citedByCount: 13,
            abstractSnippet: 'Abstract goes here',
            epmcUrl: 'https://europepmc.org/article/MED/42',
          },
        ],
        cursorMark: '*',
        nextCursorMark: 'NEXT',
        searchUrl: 'https://europepmc.org/search?query=cancer',
      });
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('Europe PMC Search Results');
      expect(text).toContain('next page');
      expect(text).toContain('Title');
      expect(text).toContain('Smith J, Jones K');
      expect(text).toContain('PMID:** 42');
      expect(text).toContain('PMCID:** PMC9');
      expect(text).toContain('DOI:** 10.1/x');
      expect(text).toContain('Open Access:** yes');
      expect(text).toContain('Cited by:** 13');
      expect(text).toContain('Abstract goes here');
    });

    it('marks the final page when no nextCursorMark', () => {
      const blocks = pubmedEuropepmcSearchTool.format!({
        hits: [],
        cursorMark: 'CURSOR_X',
        searchUrl: 'https://europepmc.org/search?query=x',
      });
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('final page');
    });
  });
});
