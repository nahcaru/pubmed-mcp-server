/**
 * @fileoverview Tests for the find-related tool.
 * @module tests/mcp-server/tools/definitions/find-related.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockELink = vi.fn();
const mockESummary = vi.fn();
const mockExtractBriefSummaries = vi.fn(() => Promise.resolve([]));
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eLink: mockELink, eSummary: mockESummary }),
}));
vi.mock('@/services/ncbi/parsing/esummary-parser.js', () => ({
  extractBriefSummaries: mockExtractBriefSummaries,
}));

const { findRelatedTool } = await import('@/mcp-server/tools/definitions/find-related.tool.js');

describe('findRelatedTool', () => {
  beforeEach(() => {
    mockELink.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockExtractBriefSummaries.mockResolvedValue([]);
  });

  it('validates input with defaults', () => {
    const input = findRelatedTool.input.parse({ pmid: '12345' });
    expect(input.pmid).toBe('12345');
    expect(input.relationship).toBe('similar');
    expect(input.maxResults).toBe(10);
  });

  it('rejects non-numeric PMIDs', () => {
    expect(() => findRelatedTool.input.parse({ pmid: 'abc' })).toThrow();
  });

  it('rejects non-numeric PMIDs with an actionable error message (issue #27)', () => {
    const parsed = findRelatedTool.input.safeParse({ pmid: 'abc' });
    expect(parsed.success).toBe(false);
    const message = parsed.error?.issues[0]?.message ?? '';
    expect(message).toMatch(/PMID/);
    expect(message).toMatch(/numeric/);
    expect(message).toContain('13054692');
  });

  it('returns empty without notice for valid source with no related articles', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [{ LinkSet: {} }],
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '12345', title: 'Existing article with no related items' },
    ]);

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(result.articles).toEqual([]);
    expect(result.totalFound).toBe(0);
    expect(result.notice).toBeUndefined();
  });

  describe('ELink <ERROR> payload', () => {
    it('disambiguates an invalid source PMID via ESummary and emits a not-found notice', async () => {
      mockELink.mockResolvedValue({
        eLinkResult: [{ ERROR: 'Invalid PMID' }],
      });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([]);

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '99999999999' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.totalFound).toBe(0);
      expect(result.articles).toEqual([]);
      expect(result.notice).toContain('99999999999');
      expect(result.notice).toContain('not found in PubMed');
    });

    it('returns empty without notice when ELink ERROR fires for a valid PMID with no related items', async () => {
      mockELink.mockResolvedValue({
        eLinkResult: [{ ERROR: 'Empty result - nothing to do' }],
      });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([
        { pmid: '12345', title: 'Valid source with no related items' },
      ]);

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '12345' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.totalFound).toBe(0);
      expect(result.notice).toBeUndefined();
    });
  });

  it('uses neighbor + pubmed_pubmed linkname for similar and enriches results', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [
        {
          LinkSet: {
            LinkSetDb: {
              LinkName: 'pubmed_pubmed',
              Link: [
                { Id: '12345' }, // source PMID — filtered out
                { Id: '0' }, // sentinel — filtered out
                { Id: '222' },
                { Id: { '#text': '111' } }, // exercise the {'#text': ...} Id shape
              ],
            },
          },
        },
      ],
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '222',
        title: 'First Related Article',
        authors: 'Jones A',
        source: 'Science',
        pubDate: '2023',
      },
      {
        pmid: '111',
        title: 'Second Related Article',
        authors: 'Smith J',
        source: 'Nature',
        pubDate: '2024',
      },
    ]);

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', maxResults: 2 });
    const result = await findRelatedTool.handler(input, ctx);

    expect(mockELink).toHaveBeenCalledWith(
      {
        dbfrom: 'pubmed',
        db: 'pubmed',
        id: '12345',
        cmd: 'neighbor',
        linkname: 'pubmed_pubmed',
        retmode: 'xml',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockESummary).toHaveBeenCalledWith(
      {
        db: 'pubmed',
        id: '222,111',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.totalFound).toBe(2);
    expect(result.articles).toEqual([
      {
        pmid: '222',
        title: 'First Related Article',
        authors: 'Jones A',
        source: 'Science',
        pubDate: '2023',
      },
      {
        pmid: '111',
        title: 'Second Related Article',
        authors: 'Smith J',
        source: 'Nature',
        pubDate: '2024',
      },
    ]);
  });

  it('uses cited_by linkname', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [
        {
          LinkSet: {
            LinkSetDb: {
              LinkName: 'pubmed_pubmed_citedin',
              Link: { Id: '222' },
            },
          },
        },
      ],
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '222',
        title: 'Citing Article',
        authors: 'Taylor R',
      },
    ]);

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(mockELink).toHaveBeenCalledWith(
      {
        dbfrom: 'pubmed',
        db: 'pubmed',
        id: '12345',
        retmode: 'xml',
        cmd: 'neighbor',
        linkname: 'pubmed_pubmed_citedin',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.articles[0]).toEqual({
      pmid: '222',
      title: 'Citing Article',
      authors: 'Taylor R',
      source: undefined,
      pubDate: undefined,
    });
  });

  it('uses the references linkname for reference lookups', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [{ LinkSet: {} }],
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '12345', title: 'Source', pmcId: 'PMC9999' },
    ]);

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'references' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(mockELink).toHaveBeenCalledWith(
      {
        dbfrom: 'pubmed',
        db: 'pubmed',
        id: '12345',
        retmode: 'xml',
        cmd: 'neighbor',
        linkname: 'pubmed_pubmed_refs',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.totalFound).toBe(0);
  });

  describe('references notice for non-PMC sources (issue #42)', () => {
    it('emits a PMC-indexing hint when the source has no PMCID', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([
        { pmid: '37952131', title: 'Non-PMC source' /* no pmcId */ },
      ]);

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({
        pmid: '37952131',
        relationship: 'references',
      });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.totalFound).toBe(0);
      expect(result.notice).toBeDefined();
      expect(result.notice).toContain('PMC');
      expect(result.notice).toContain('37952131');
      expect(result.notice).toContain('pubmed_fetch_articles');
    });

    it('emits a PMC-no-refs hint when the source has a PMCID but no references', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([
        { pmid: '12345', title: 'PMC source', pmcId: 'PMC12345' },
      ]);

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'references' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.notice).toBeDefined();
      expect(result.notice).toContain('PMCID PMC12345');
    });

    it('omits notice for similar / cited_by empty results when source PMID is valid', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([{ pmid: '12345', title: 'Valid source' }]);

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'similar' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.notice).toBeUndefined();
      expect(mockESummary).toHaveBeenCalledTimes(1);
    });

    it('falls back gracefully when the ESummary lookup fails (transport error)', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockRejectedValue(new Error('NCBI down'));

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'references' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.totalFound).toBe(0);
      expect(result.notice).toBeUndefined();
    });

    it('emits invalid-PMID notice when source ESummary returns nothing', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([]);

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({
        pmid: '99999999999',
        relationship: 'references',
      });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.notice).toContain('99999999999');
      expect(result.notice).toContain('not found in PubMed');
      // Invalid-source notice supersedes the references-specific hint.
      expect(result.notice).not.toContain('PMC');
    });

    it('renders the notice as a blockquote in format()', () => {
      const blocks = findRelatedTool.format!({
        sourcePmid: '37952131',
        relationship: 'references',
        articles: [],
        totalFound: 0,
        notice:
          'Reference lists require the source article to be indexed in PMC. PMID 37952131 has no PMCID — references unavailable. Use pubmed_fetch_articles to inspect the article record, or try relationship: "similar" / "cited_by".',
      });
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('> Reference lists require');
      expect(text).not.toContain('No related articles found.');
    });
  });

  it('formats output with articles', () => {
    const blocks = findRelatedTool.format!({
      sourcePmid: '12345',
      relationship: 'similar',
      articles: [
        {
          pmid: '111',
          title: 'Related Article',
          authors: 'Smith J',
          source: 'Nature',
          pubDate: '2024',
        },
      ],
      totalFound: 1,
    });
    expect(blocks[0]?.text).toContain('Related Articles');
    expect(blocks[0]?.text).toContain('12345');
    expect(blocks[0]?.text).toContain('Related Article');
    expect(blocks[0]?.text).toContain('*Smith J*');
    expect(blocks[0]?.text).toContain('Nature, 2024');
  });

  it('formats output with no articles', () => {
    const blocks = findRelatedTool.format!({
      sourcePmid: '12345',
      relationship: 'cited_by',
      articles: [],
      totalFound: 0,
    });
    expect(blocks[0]?.text).toContain('No related articles');
  });

  describe('invalid source PMID detection (issue #22)', () => {
    const invalidPmidNotice = (relationship: 'similar' | 'cited_by' | 'references') => async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([]);

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '99999999999', relationship });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.totalFound).toBe(0);
      expect(result.articles).toEqual([]);
      expect(result.notice).toContain('99999999999');
      expect(result.notice).toContain('not found in PubMed');
      expect(result.notice).toContain('pubmed_fetch_articles');
    };

    it(
      'emits notice for similar relationship when source PMID is unknown',
      invalidPmidNotice('similar'),
    );
    it(
      'emits notice for cited_by relationship when source PMID is unknown',
      invalidPmidNotice('cited_by'),
    );
    it(
      'emits notice for references relationship when source PMID is unknown',
      invalidPmidNotice('references'),
    );

    it('treats NCBI NotFound throw as confirmed missing PMID (via error code)', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockRejectedValue(
        new McpError(JsonRpcErrorCode.NotFound, 'NCBI API Error: cannot get summary', {
          reason: 'ncbi_resource_not_found',
          ncbiErrors: ['UID=99999999999: cannot get document summary'],
        }),
      );

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '99999999999', relationship: 'similar' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.notice).toContain('99999999999');
      expect(result.notice).toContain('not found in PubMed');
    });

    it('does NOT emit invalid notice on transient transport failure', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockRejectedValue(new Error('connect ETIMEDOUT'));

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'similar' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.totalFound).toBe(0);
      expect(result.notice).toBeUndefined();
    });
  });
});
