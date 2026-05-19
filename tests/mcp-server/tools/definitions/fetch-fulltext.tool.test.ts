/**
 * @fileoverview Tests for the fetch-fulltext tool.
 * @module tests/mcp-server/tools/definitions/fetch-fulltext.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEFetch = vi.fn();
const mockIdConvert = vi.fn();
const mockParsePmcArticle = vi.fn();
const mockUnpaywallResolve = vi.fn();
const mockUnpaywallFetchContent = vi.fn();
const mockGetUnpaywallService = vi.fn();
const mockEpmcSearch = vi.fn();
const mockEpmcFullTextXml = vi.fn();
const mockEpmcParseFullTextXml = vi.fn();
const mockGetEpmcService = vi.fn();
const mockHtmlExtract = vi.fn();
const mockPdfExtractText = vi.fn();

vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eFetch: mockEFetch, idConvert: mockIdConvert }),
}));
vi.mock('@/services/ncbi/parsing/pmc-article-parser.js', () => ({
  parsePmcArticle: mockParsePmcArticle,
}));
vi.mock('@/services/unpaywall/unpaywall-service.js', () => ({
  getUnpaywallService: () => mockGetUnpaywallService(),
}));
vi.mock('@/services/europe-pmc/europe-pmc-service.js', () => ({
  getEuropePmcService: () => mockGetEpmcService(),
}));
vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@cyanheads/mcp-ts-core/utils');
  return {
    ...actual,
    htmlExtractor: { extract: mockHtmlExtract },
    pdfParser: { extractText: mockPdfExtractText },
  };
});

const { fetchFulltextTool } = await import('@/mcp-server/tools/definitions/fetch-fulltext.tool.js');

/**
 * Configure `mockEFetch` to dispatch by `db` — mirrors production:
 *   - `db=pmc` returns the PMC JATS body.
 *   - `db=pubmed` returns a PubmedArticleSet where each entry encodes a DOI in
 *     the canonical ELocationID[ValidYN=Y] slot, reflecting how NCBI surfaces
 *     DOIs for articles the PMC ID Converter omits.
 */
function mockEFetchBy(opts: { pmc?: unknown; pubmedDois?: Record<string, string> }) {
  mockEFetch.mockImplementation(async (params: { db: string }) => {
    if (params.db === 'pmc') {
      return opts.pmc ?? [{ 'pmc-articleset': [{ article: [] }] }];
    }
    if (params.db === 'pubmed') {
      const pmidToDoi = opts.pubmedDois ?? {};
      const articles = Object.entries(pmidToDoi).map(([pmid, doi]) => ({
        MedlineCitation: {
          PMID: { '#text': pmid },
          Article: {
            ELocationID: [{ '#text': doi, '@_EIdType': 'doi', '@_ValidYN': 'Y' }],
          },
        },
      }));
      return { PubmedArticleSet: { PubmedArticle: articles } };
    }
    throw new Error(`Unexpected eFetch db=${params.db}`);
  });
}

describe('fetchFulltextTool', () => {
  beforeEach(() => {
    mockEFetch.mockReset();
    mockIdConvert.mockReset();
    mockParsePmcArticle.mockReset();
    mockUnpaywallResolve.mockReset();
    mockUnpaywallFetchContent.mockReset();
    mockGetUnpaywallService.mockReset();
    mockEpmcSearch.mockReset();
    mockEpmcFullTextXml.mockReset();
    mockEpmcParseFullTextXml.mockReset();
    mockGetEpmcService.mockReset();
    mockHtmlExtract.mockReset();
    mockPdfExtractText.mockReset();
    mockGetUnpaywallService.mockReturnValue(undefined);
    mockGetEpmcService.mockReturnValue(undefined);
  });

  describe('input validation', () => {
    it('accepts pmcids', () => {
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC1234567'] });
      expect(input.pmcids).toEqual(['PMC1234567']);
    });

    it('accepts dois (issue #52)', () => {
      const input = fetchFulltextTool.input.parse({ dois: ['10.1000/example'] });
      expect(input.dois).toEqual(['10.1000/example']);
    });

    it('rejects non-numeric PMIDs with an actionable error message (issue #27)', () => {
      const parsed = fetchFulltextTool.input.safeParse({ pmids: ['abc'] });
      expect(parsed.success).toBe(false);
      const message = parsed.error?.issues[0]?.message ?? '';
      expect(message).toMatch(/PMID/);
      expect(message).toMatch(/numeric/);
      expect(message).toContain('13054692');
    });

    it('rejects input with no input branch (issue #46)', () => {
      const parsed = fetchFulltextTool.input.safeParse({});
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toMatch(/exactly one of/);
    });

    it('rejects input with two branches set (issue #46)', () => {
      const parsed = fetchFulltextTool.input.safeParse({
        pmcids: ['PMC1'],
        pmids: ['12345'],
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toMatch(/exactly one of/);
    });

    it('rejects input with all three branches set', () => {
      const parsed = fetchFulltextTool.input.safeParse({
        pmcids: ['PMC1'],
        pmids: ['12345'],
        dois: ['10.1/x'],
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects input with pmids and dois set together', () => {
      const parsed = fetchFulltextTool.input.safeParse({
        pmids: ['12345'],
        dois: ['10.1/x'],
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('PMC path (existing behavior)', () => {
    it('fetches by PMC IDs and tags articles with viaSource=pmc', async () => {
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC1234567',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/',
        title: 'Full Text Article',
        sections: [{ title: 'Introduction', text: 'Body text.' }],
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [{ article: [] }] }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC1234567'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockEFetch).toHaveBeenCalledWith(
        { db: 'pmc', id: '1234567', retmode: 'xml' },
        expect.objectContaining({
          retmode: 'xml',
          useOrderedParser: true,
          usePost: false,
          signal: expect.any(AbortSignal),
        }),
      );
      expect(result.totalReturned).toBe(1);
      const first = result.articles[0];
      expect(first?.source).toBe('pmc');
      if (first?.source === 'pmc') {
        expect(first.viaSource).toBe('pmc');
        expect(first.pmcId).toBe('PMC1234567');
        expect(first.title).toBe('Full Text Article');
      }
    });

    it('falls through to next tier when PMC EFetch returns a malformed payload', async () => {
      // The chain's contract is graceful fallback — a malformed PMC response
      // gets stamped as pmc:service-error and downstream tiers still run.
      mockEFetch.mockResolvedValue([]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC1'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([
        {
          id: 'PMC1',
          idType: 'pmcid',
          reason: 'service-error',
          triedTiers: [
            {
              tier: 'pmc',
              outcome: 'service-error',
              detail: 'PMC EFetch response missing pmc-articleset wrapper',
            },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            {
              tier: 'unpaywall',
              outcome: 'not-attempted',
              detail: 'pmcids input does not resolve a DOI for Unpaywall',
            },
          ],
        },
      ]);
    });

    it('routes pmcids batch to fallback tiers when PMC EFetch throws', async () => {
      mockEFetch.mockRejectedValue(new Error('NCBI 503'));

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC1', 'PMC2'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([
        {
          id: 'PMC1',
          idType: 'pmcid',
          reason: 'service-error',
          triedTiers: [
            { tier: 'pmc', outcome: 'service-error', detail: 'NCBI 503' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            {
              tier: 'unpaywall',
              outcome: 'not-attempted',
              detail: 'pmcids input does not resolve a DOI for Unpaywall',
            },
          ],
        },
        {
          id: 'PMC2',
          idType: 'pmcid',
          reason: 'service-error',
          triedTiers: [
            { tier: 'pmc', outcome: 'service-error', detail: 'NCBI 503' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            {
              tier: 'unpaywall',
              outcome: 'not-attempted',
              detail: 'pmcids input does not resolve a DOI for Unpaywall',
            },
          ],
        },
      ]);
    });

    it('reports unavailable PMC IDs when the chain finds nothing', async () => {
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC9999999'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(0);
      expect(result.articles).toEqual([]);
      expect(result.unavailable).toEqual([
        {
          id: 'PMC9999999',
          idType: 'pmcid',
          reason: 'not-found',
          triedTiers: [
            { tier: 'pmc', outcome: 'miss' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            {
              tier: 'unpaywall',
              outcome: 'not-attempted',
              detail: 'pmcids input does not resolve a DOI for Unpaywall',
            },
          ],
        },
      ]);
    });

    it('normalizes direct PMC IDs and uses POST for large batches', async () => {
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC111',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC111/',
        title: 'Direct PMC Article',
        sections: [],
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [{ article: [] }] }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({
        pmcids: ['PMC111', '222', '333', '444', '555', '666'],
      });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockEFetch).toHaveBeenCalledWith(
        { db: 'pmc', id: '111,222,333,444,555,666', retmode: 'xml' },
        expect.objectContaining({
          retmode: 'xml',
          useOrderedParser: true,
          usePost: true,
          signal: expect.any(AbortSignal),
        }),
      );
      const expectedPmcMissChain = [
        { tier: 'pmc', outcome: 'miss' },
        { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
        {
          tier: 'unpaywall',
          outcome: 'not-attempted',
          detail: 'pmcids input does not resolve a DOI for Unpaywall',
        },
      ];
      expect(result.unavailable).toEqual([
        { id: 'PMC222', idType: 'pmcid', reason: 'not-found', triedTiers: expectedPmcMissChain },
        { id: 'PMC333', idType: 'pmcid', reason: 'not-found', triedTiers: expectedPmcMissChain },
        { id: 'PMC444', idType: 'pmcid', reason: 'not-found', triedTiers: expectedPmcMissChain },
        { id: 'PMC555', idType: 'pmcid', reason: 'not-found', triedTiers: expectedPmcMissChain },
        { id: 'PMC666', idType: 'pmcid', reason: 'not-found', triedTiers: expectedPmcMissChain },
      ]);
    });
  });

  describe('pmids → resolution chain', () => {
    it('resolves PMIDs via idConvert and applies section/reference filtering', async () => {
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '12345', pmid: '12345', pmcid: 'PMC777' },
        { 'requested-id': '99999', pmid: '99999' },
      ]);
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC777',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC777/',
        pmid: '12345',
        title: 'Resolved Article',
        sections: [
          { title: 'Introduction', text: 'Intro text.' },
          { title: 'Methods', text: 'Methods text.' },
        ],
        references: [{ label: '1', citation: 'Reference one' }],
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [{ article: [] }] }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({
        pmids: ['12345', '99999'],
        sections: ['intro'],
        maxSections: 1,
      });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.unavailable).toEqual([
        {
          id: '99999',
          idType: 'pmid',
          reason: 'no-pmc-fallback-disabled',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'not-attempted', detail: 'UNPAYWALL_EMAIL is not set' },
          ],
        },
      ]);
      const pmc = result.articles[0];
      expect(pmc?.source).toBe('pmc');
      if (pmc?.source === 'pmc') {
        expect(pmc.viaSource).toBe('pmc');
        expect(pmc.sections).toEqual([{ title: 'Introduction', text: 'Intro text.' }]);
        expect(pmc.references).toBeUndefined();
      }
    });

    it('returns empty when no PMIDs resolve and all fallbacks are disabled', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '99999', pmid: '99999' }]);
      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['99999'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([
        {
          id: '99999',
          idType: 'pmid',
          reason: 'no-pmc-fallback-disabled',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'not-attempted', detail: 'UNPAYWALL_EMAIL is not set' },
          ],
        },
      ]);
    });
  });

  describe('Europe PMC fallback (issue #52)', () => {
    function withEpmcMock() {
      mockGetEpmcService.mockReturnValue({
        search: mockEpmcSearch,
        fullTextXml: mockEpmcFullTextXml,
        parseFullTextXml: mockEpmcParseFullTextXml,
      });
    }

    it('recovers a PMID via Europe PMC fullTextXML when PMC misses it', async () => {
      // PMID had no PMC counterpart per the ID Converter, but the same article
      // surfaces in EPMC under SRC:MED with a `pmcid` — EPMC's fullTextXML is
      // PMC-keyed, so the chain looks up the JATS via that PMC ID.
      withEpmcMock();
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEpmcSearch.mockResolvedValue({
        hits: [{ id: '42', source: 'MED', pmid: '42', pmcid: 'PMC42', doi: '10.1/x' }],
        hitCount: 1,
        cursorMark: '*',
      });
      mockEpmcFullTextXml.mockResolvedValue({
        kind: 'found',
        xml: '<article/>',
        epmcId: 'PMC42',
        source: 'MED',
      });
      mockEpmcParseFullTextXml.mockReturnValue({ article: [{ body: [] }] });
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC42',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC42/',
        title: 'EPMC-served article',
        sections: [{ title: 'Background', text: 'Body' }],
      });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockEpmcFullTextXml).toHaveBeenCalledWith('PMC42', 'MED', expect.any(AbortSignal));
      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('pmc');
      if (article?.source === 'pmc') {
        expect(article.viaSource).toBe('europepmc');
        expect(article.epmcId).toBe('42');
        expect(article.epmcSource).toBe('MED');
        expect(article.pmid).toBe('42');
        expect(article.pmcId).toBe('PMC42');
      }
      expect(result.unavailable).toBeUndefined();
    });

    it('skips fullTextXML for preprint hits with no PMC counterpart', async () => {
      withEpmcMock();
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
      mockEpmcSearch.mockResolvedValue({
        hits: [{ id: 'PPR42', source: 'PPR', doi: '10.21203/x' }],
        hitCount: 1,
        cursorMark: '*',
      });
      mockUnpaywallResolve.mockResolvedValue({ kind: 'no-oa', reason: 'no oa' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.21203/x'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      // No PMC ID on the PPR hit → fullTextXML is never called.
      expect(mockEpmcFullTextXml).not.toHaveBeenCalled();
      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([
        {
          id: '10.21203/x',
          idType: 'doi',
          reason: 'no-oa',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'DOI input bypasses PMC EFetch' },
            {
              tier: 'europepmc',
              outcome: 'no-fulltext',
              detail: 'EPMC source PPR has no PMC counterpart',
            },
            { tier: 'unpaywall', outcome: 'no-oa', detail: 'no oa' },
          ],
        },
      ]);
    });

    it('removes EPMC-recovered PMCIDs from the unavailable list', async () => {
      withEpmcMock();
      mockEpmcSearch.mockResolvedValue({
        hits: [{ id: 'PMC9999', source: 'PMC', pmcid: 'PMC9999', doi: '10.1/x' }],
        hitCount: 1,
        cursorMark: '*',
      });
      mockEpmcFullTextXml.mockResolvedValue({
        kind: 'found',
        xml: '<article/>',
        epmcId: 'PMC9999',
        source: 'PMC',
      });
      mockEpmcParseFullTextXml.mockReturnValue({ article: [{ body: [] }] });
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC9999',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9999/',
        title: 'EPMC-served PMC article',
        sections: [],
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC9999'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      expect(result.articles[0]?.source).toBe('pmc');
      if (result.articles[0]?.source === 'pmc') {
        expect(result.articles[0].viaSource).toBe('europepmc');
      }
      expect(result.unavailable).toBeUndefined();
    });

    it('falls through to Unpaywall when EPMC has no full text for the record', async () => {
      withEpmcMock();
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockEpmcSearch.mockResolvedValue({
        hits: [{ id: 'PPR42', source: 'PPR', pmid: '42', doi: '10.1000/example' }],
        hitCount: 1,
        cursorMark: '*',
      });
      mockEpmcFullTextXml.mockResolvedValue({ kind: 'not-available', reason: 'no XML' });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper', license: 'cc-by' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body>Body</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ title: 'A paper', content: 'Body content' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') {
        expect(article.viaSource).toBe('unpaywall');
        expect(article.pmid).toBe('42');
        expect(article.doi).toBe('10.1000/example');
      }
    });

    it('continues chain when EPMC search throws', async () => {
      withEpmcMock();
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockEpmcSearch.mockRejectedValue(new Error('EPMC 503'));
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body>Body</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ content: 'Body content' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      expect(result.articles[0]?.source).toBe('unpaywall');
    });

    it('recovers a pmid via EPMC when PMC EFetch misses the converter-resolved PMCID', async () => {
      // Regression: PMID had a PMCID per the ID Converter (so it went into the
      // PMC EFetch batch), but PMC didn't return the article. The chain must
      // route this pmid into the EPMC stage with its known doi hint preserved.
      withEpmcMock();
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '42', pmid: '42', pmcid: 'PMC42', doi: '10.1/x' },
      ]);
      // PMC EFetch returns no articles so the converter-resolved PMCID misses.
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);
      mockEpmcSearch.mockResolvedValue({
        hits: [{ id: '42', source: 'MED', pmid: '42', pmcid: 'PMC42', doi: '10.1/x' }],
        hitCount: 1,
        cursorMark: '*',
      });
      mockEpmcFullTextXml.mockResolvedValue({
        kind: 'found',
        xml: '<article/>',
        epmcId: 'PMC42',
        source: 'MED',
      });
      mockEpmcParseFullTextXml.mockReturnValue({ article: [{ body: [] }] });
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC42',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC42/',
        title: 'EPMC-recovered article',
        sections: [],
      });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockEpmcSearch).toHaveBeenCalled();
      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('pmc');
      if (article?.source === 'pmc') {
        expect(article.viaSource).toBe('europepmc');
        expect(article.pmid).toBe('42');
      }
      expect(result.unavailable).toBeUndefined();
    });

    it('falls all the way to Unpaywall when PMC misses a converter-resolved PMCID and EPMC has no fulltext', async () => {
      withEpmcMock();
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '42', pmid: '42', pmcid: 'PMC42', doi: '10.1/x' },
      ]);
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body>Body</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ content: 'Body content' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      // The DOI hint from idConvert should mean no PubMed metadata round-trip.
      expect(mockEFetch).toHaveBeenCalledTimes(1);
      expect(mockUnpaywallResolve).toHaveBeenCalledWith('10.1/x', expect.any(AbortSignal));
      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') {
        expect(article.pmid).toBe('42');
        expect(article.doi).toBe('10.1/x');
      }
    });
  });

  describe('Unpaywall fallback for pmids (regression)', () => {
    beforeEach(() => {
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
    });

    it('returns no-doi when neither the ID Converter nor PubMed metadata surfaces a DOI', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: {} });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([
        {
          id: '42',
          idType: 'pmid',
          reason: 'no-doi',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'no-doi' },
          ],
        },
      ]);
      expect(mockUnpaywallResolve).not.toHaveBeenCalled();
    });

    it('sources the DOI from PubMed metadata when ID Converter omits it', async () => {
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '42', pmid: '42', errmsg: 'Identifier not found in PMC' },
      ]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper', license: 'cc-by' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body>hi</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ title: 'A Paper', content: 'hi' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockUnpaywallResolve).toHaveBeenCalledWith('10.1000/example', expect.any(AbortSignal));
      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') {
        expect(article.viaSource).toBe('unpaywall');
        expect(article.doi).toBe('10.1000/example');
        expect(article.pmid).toBe('42');
      }
    });

    it('returns no-oa when Unpaywall has no open-access copy', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'no-oa',
        reason: 'No open-access copy indexed',
      });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.unavailable).toEqual([
        {
          id: '42',
          idType: 'pmid',
          reason: 'no-oa',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'no-oa', detail: 'No open-access copy indexed' },
          ],
        },
      ]);
    });

    it('returns service-error when Unpaywall lookup fails', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockRejectedValue(new Error('Unpaywall 503'));

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockUnpaywallFetchContent).not.toHaveBeenCalled();
      expect(result.unavailable).toEqual([
        {
          id: '42',
          idType: 'pmid',
          reason: 'service-error',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'service-error', detail: 'Unpaywall 503' },
          ],
        },
      ]);
    });

    it('returns fetch-failed when the content download throws', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper' },
      });
      mockUnpaywallFetchContent.mockRejectedValue(new Error('HTTP 503'));

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.unavailable).toEqual([
        {
          id: '42',
          idType: 'pmid',
          reason: 'fetch-failed',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'fetch-failed', detail: 'HTTP 503' },
          ],
        },
      ]);
    });

    it('returns an unpaywall article with contentFormat=html-markdown when HTML extraction succeeds', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: {
          url: 'https://repo.example.org/paper',
          host_type: 'repository',
          license: 'cc-by',
          version: 'acceptedVersion',
        },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body><article>Main body</article></body></html>',
      });
      mockHtmlExtract.mockResolvedValue({
        title: 'A Paper',
        content: '# A Paper\n\nMain body',
        wordCount: 2,
      });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') {
        expect(article.contentFormat).toBe('html-markdown');
        expect(article.pmid).toBe('42');
        expect(article.doi).toBe('10.1000/example');
        expect(article.sourceUrl).toBe('https://repo.example.org/paper');
        expect(article.title).toBe('A Paper');
        expect(article.content).toContain('Main body');
        expect(article.license).toBe('cc-by');
        expect(article.hostType).toBe('repository');
        expect(article.version).toBe('acceptedVersion');
        expect(article.wordCount).toBe(2);
        expect(article.totalPages).toBeUndefined();
      }
    });

    it('returns an unpaywall article with contentFormat=pdf-text when PDF extraction succeeds', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: {
          url: 'https://arxiv.org/abs/2401.0001',
          url_for_pdf: 'https://arxiv.org/pdf/2401.0001.pdf',
          host_type: 'repository',
          license: 'cc0',
          version: 'submittedVersion',
        },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'pdf',
        fetchedUrl: 'https://arxiv.org/pdf/2401.0001.pdf',
        body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      });
      mockPdfExtractText.mockResolvedValue({ totalPages: 7, text: 'Paper text' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') {
        expect(article.contentFormat).toBe('pdf-text');
        expect(article.content).toBe('Paper text');
        expect(article.totalPages).toBe(7);
        expect(article.wordCount).toBeUndefined();
        expect(article.license).toBe('cc0');
        expect(article.sourceUrl).toBe('https://arxiv.org/pdf/2401.0001.pdf');
      }
    });

    it('flags parse-failed when HTML extraction produces empty content', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html></html>',
      });
      mockHtmlExtract.mockResolvedValue({ content: '   ' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.unavailable).toEqual([
        {
          id: '42',
          idType: 'pmid',
          reason: 'parse-failed',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            {
              tier: 'unpaywall',
              outcome: 'parse-failed',
              detail: expect.stringContaining('empty'),
            },
          ],
        },
      ]);
    });

    it('flags parse-failed when PDF extraction produces empty text', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url_for_pdf: 'https://repo.example.org/paper.pdf' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'pdf',
        fetchedUrl: 'https://repo.example.org/paper.pdf',
        body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      });
      mockPdfExtractText.mockResolvedValue({ totalPages: 3, text: '   ' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.unavailable).toEqual([
        {
          id: '42',
          idType: 'pmid',
          reason: 'parse-failed',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            {
              tier: 'unpaywall',
              outcome: 'parse-failed',
              detail: expect.stringContaining('PDF extraction'),
            },
          ],
        },
      ]);
    });

    it('flags parse-failed when content extraction throws', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body>broken</body></html>',
      });
      mockHtmlExtract.mockRejectedValue(new Error('extractor crashed'));

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.unavailable).toEqual([
        {
          id: '42',
          idType: 'pmid',
          reason: 'parse-failed',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'parse-failed', detail: 'extractor crashed' },
          ],
        },
      ]);
    });

    it('combines PMC hits with Unpaywall fallback in a single response', async () => {
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '1', pmid: '1', pmcid: 'PMC100' },
        { 'requested-id': '2', pmid: '2' },
      ]);
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC100',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC100/',
        pmid: '1',
        title: 'PMC Hit',
        sections: [],
      });
      mockEFetchBy({
        pmc: [{ 'pmc-articleset': [{ article: [] }] }],
        pubmedDois: { '2': '10.1000/two' },
      });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/two' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/two',
        body: '<html><body>Two</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ title: 'Two', content: 'Two content' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['1', '2'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(2);
      expect(result.articles.map((a) => a.source)).toEqual(['pmc', 'unpaywall']);
      expect(result.unavailable).toBeUndefined();
    });
  });

  describe('dois input branch (issue #52)', () => {
    function withEpmcAndUnpaywall() {
      mockGetEpmcService.mockReturnValue({
        search: mockEpmcSearch,
        fullTextXml: mockEpmcFullTextXml,
        parseFullTextXml: mockEpmcParseFullTextXml,
      });
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
    }

    it('skips PMC EFetch entirely for dois input', async () => {
      withEpmcAndUnpaywall();
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
      mockUnpaywallResolve.mockResolvedValue({ kind: 'no-oa', reason: 'no oa' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.1000/test'] });
      await fetchFulltextTool.handler(input, ctx);

      expect(mockIdConvert).not.toHaveBeenCalled();
      const pmcCalls = mockEFetch.mock.calls.filter(
        ([params]: [{ db: string }]) => params.db === 'pmc',
      );
      expect(pmcCalls).toHaveLength(0);
    });

    it('recovers a DOI via Europe PMC fullTextXML', async () => {
      // EPMC's fullTextXML endpoint is PMC-keyed, so EPMC recovery for a DOI
      // requires a hit with a PMC counterpart (`pmcid`). Preprints (`PPR`) and
      // MED-only records have no PMC ID and never return JATS via EPMC.
      withEpmcAndUnpaywall();
      mockEpmcSearch.mockResolvedValue({
        hits: [{ id: '42', source: 'MED', pmid: '42', pmcid: 'PMC42', doi: '10.1/x' }],
        hitCount: 1,
        cursorMark: '*',
      });
      mockEpmcFullTextXml.mockResolvedValue({
        kind: 'found',
        xml: '<article/>',
        epmcId: 'PMC42',
        source: 'MED',
      });
      mockEpmcParseFullTextXml.mockReturnValue({ article: [{ body: [] }] });
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC42',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC42/',
        title: 'EPMC-served article',
        sections: [{ title: 'Methods', text: 'Methods body' }],
        doi: '10.1/x',
      });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.1/x'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockEpmcSearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'DOI:"10.1/x"' }),
      );
      expect(mockEpmcFullTextXml).toHaveBeenCalledWith('PMC42', 'MED', expect.any(AbortSignal));
      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('pmc');
      if (article?.source === 'pmc') {
        expect(article.viaSource).toBe('europepmc');
        expect(article.epmcId).toBe('42');
        expect(article.epmcSource).toBe('MED');
        expect(article.doi).toBe('10.1/x');
        expect(article.pmcId).toBe('PMC42');
      }
      expect(result.unavailable).toBeUndefined();
    });

    it('falls through to Unpaywall when EPMC has no fullTextXML for the DOI', async () => {
      withEpmcAndUnpaywall();
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper', license: 'cc-by' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body>Body</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ content: 'Body content', title: 'Paper' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.1000/test'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') {
        expect(article.viaSource).toBe('unpaywall');
        expect(article.doi).toBe('10.1000/test');
        // No PMID in dois branch
        expect(article.pmid).toBeUndefined();
        expect(article.pubmedUrl).toBeUndefined();
      }
      expect(result.unavailable).toBeUndefined();
    });

    it('reports unavailable when both EPMC and Unpaywall fail', async () => {
      withEpmcAndUnpaywall();
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
      mockUnpaywallResolve.mockResolvedValue({ kind: 'no-oa', reason: 'no oa' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.1000/missing'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([
        {
          id: '10.1000/missing',
          idType: 'doi',
          reason: 'no-oa',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'DOI input bypasses PMC EFetch' },
            { tier: 'europepmc', outcome: 'miss' },
            { tier: 'unpaywall', outcome: 'no-oa', detail: 'no oa' },
          ],
        },
      ]);
    });

    it('reports unavailable when EPMC is disabled and Unpaywall is unset', async () => {
      // No EPMC mock; no Unpaywall mock — both services return undefined
      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.1000/foo'] });
      const result = await fetchFulltextTool.handler(input, ctx);
      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([
        {
          id: '10.1000/foo',
          idType: 'doi',
          reason: 'no-pmc-fallback-disabled',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'DOI input bypasses PMC EFetch' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'not-attempted', detail: 'UNPAYWALL_EMAIL is not set' },
          ],
        },
      ]);
    });
  });

  describe('format()', () => {
    it('formats a PMC article with full metadata', () => {
      const blocks = fetchFulltextTool.format!({
        articles: [
          {
            source: 'pmc',
            viaSource: 'pmc',
            pmcId: 'PMC1',
            pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/',
            title: 'Article',
            pmid: '12345',
            pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345/',
            authors: [
              { lastName: 'Smith', givenNames: 'Jane' },
              { lastName: 'Jones', givenNames: 'Alex' },
              { lastName: 'Brown', givenNames: 'Sam' },
              { lastName: 'White', givenNames: 'Pat' },
            ],
            affiliations: ['Example University'],
            journal: { title: 'Nature', volume: '12', issue: '3', pages: '45-52' },
            articleType: 'Research Article',
            publicationDate: { year: '2024', month: '01', day: '02' },
            doi: '10.1000/example',
            keywords: ['asthma', 'airway'],
            abstract: 'Abstract text.',
            sections: [
              {
                title: 'Introduction',
                text: 'Body.',
                subsections: [{ title: 'Background', text: 'Background text.' }],
              },
            ],
            references: [{ label: '1', citation: 'Reference one' }],
          },
        ],
        totalReturned: 1,
        unavailable: [
          {
            id: '99999',
            idType: 'pmid',
            reason: 'no-oa',
            detail: 'No open-access copy indexed',
            triedTiers: [
              { tier: 'pmc', outcome: 'miss' },
              { tier: 'europepmc', outcome: 'no-fulltext' },
              { tier: 'unpaywall', outcome: 'no-oa', detail: 'No open-access copy indexed' },
            ],
          },
          {
            id: 'PMC404',
            idType: 'pmcid',
            reason: 'not-found',
            triedTiers: [{ tier: 'pmc', outcome: 'miss' }],
          },
        ],
      });

      const text = blocks[0]?.text ?? '';
      expect(text).toContain('Full-Text Articles');
      expect(text).toContain('Article');
      expect(text).toContain('Unavailable (2)');
      expect(text).toContain('[pmid] 99999 — no-oa');
      expect(text).toContain('[pmcid] PMC404 — not-found');
      expect(text).toContain('chain: pmc:miss → europepmc:no-fulltext → unpaywall:no-oa');
      expect(text).toContain('Affiliations');
      expect(text).toContain('Nature, **12**(3), 45-52');
      expect(text).toContain('Published:** 2024-01-02');
      expect(text).toContain('Keywords:** asthma, airway');
      expect(text).toContain('#### Abstract');
      expect(text).toContain('##### Background');
      expect(text).toContain('References (1)');
      expect(text).toContain('[1] Reference one');
    });

    it('labels EPMC-sourced PMC articles with the EPMC source name', () => {
      const blocks = fetchFulltextTool.format!({
        articles: [
          {
            source: 'pmc',
            viaSource: 'europepmc',
            epmcId: 'PPR42',
            epmcSource: 'PPR',
            title: 'Preprint',
            sections: [],
            doi: '10.21203/x',
          },
        ],
        totalReturned: 1,
      });

      const text = blocks[0]?.text ?? '';
      expect(text).toContain('Europe PMC (structured JATS');
      expect(text).toContain('source: PPR');
      expect(text).toContain('EPMC ID:** PPR42');
    });

    it('renders unavailable DOIs in the unified unavailable section', () => {
      const blocks = fetchFulltextTool.format!({
        articles: [],
        totalReturned: 0,
        unavailable: [
          {
            id: '10.1000/foo',
            idType: 'doi',
            reason: 'no-oa',
            triedTiers: [{ tier: 'unpaywall', outcome: 'no-oa' }],
          },
          {
            id: '10.1000/bar',
            idType: 'doi',
            reason: 'no-oa',
            triedTiers: [{ tier: 'unpaywall', outcome: 'no-oa' }],
          },
        ],
      });
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('Unavailable (2)');
      expect(text).toContain('[doi] 10.1000/foo');
      expect(text).toContain('[doi] 10.1000/bar');
      expect(text).toContain('chain: unpaywall:no-oa');
    });

    it('formats an unpaywall article with viaSource=unpaywall', () => {
      const blocks = fetchFulltextTool.format!({
        articles: [
          {
            source: 'unpaywall',
            viaSource: 'unpaywall',
            contentFormat: 'html-markdown',
            pmid: '42',
            pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42/',
            doi: '10.1000/example',
            sourceUrl: 'https://repo.example.org/paper',
            title: 'A Paper',
            content: '# A Paper\n\nMain body',
            wordCount: 1200,
            license: 'cc-by',
            hostType: 'repository',
            version: 'acceptedVersion',
          },
        ],
        totalReturned: 1,
      });

      const text = blocks[0]?.text ?? '';
      expect(text).toContain('A Paper');
      expect(text).toContain('Unpaywall (HTML → Markdown, best-effort)');
      expect(text).toContain('License:** cc-by');
      expect(text).toContain('Main body');
    });

    it('formats a doi-input unpaywall article (no pmid)', () => {
      const blocks = fetchFulltextTool.format!({
        articles: [
          {
            source: 'unpaywall',
            viaSource: 'unpaywall',
            contentFormat: 'pdf-text',
            doi: '10.21203/x',
            sourceUrl: 'https://repo.example.org/paper.pdf',
            content: 'Paper text',
            totalPages: 7,
          },
        ],
        totalReturned: 1,
      });

      const text = blocks[0]?.text ?? '';
      expect(text).toContain('DOI 10.21203/x');
      expect(text).toContain('Pages:** 7');
      expect(text).not.toContain('PubMed:**');
    });

    it('formats an unpaywall article (pdf-text) with page count', () => {
      const blocks = fetchFulltextTool.format!({
        articles: [
          {
            source: 'unpaywall',
            viaSource: 'unpaywall',
            contentFormat: 'pdf-text',
            pmid: '42',
            pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42/',
            doi: '10.1000/example',
            sourceUrl: 'https://arxiv.org/pdf/2401.0001.pdf',
            content: 'Paper text',
            totalPages: 7,
            license: 'cc0',
            hostType: 'repository',
            version: 'submittedVersion',
          },
        ],
        totalReturned: 1,
      });

      const text = blocks[0]?.text ?? '';
      expect(text).toContain('Unpaywall (PDF → plain text)');
      expect(text).toContain('Pages:** 7');
      expect(text).toContain('License:** cc0');
      expect(text).toContain('Paper text');
    });

    describe('empty-result recovery guidance (issue #33)', () => {
      it('emits a recovery blockquote when totalReturned is 0', () => {
        const blocks = fetchFulltextTool.format!({
          articles: [],
          totalReturned: 0,
          unavailable: [
            {
              id: '31295471',
              idType: 'pmid',
              reason: 'no-doi',
              triedTiers: [{ tier: 'unpaywall', outcome: 'no-doi' }],
            },
          ],
        });

        const text = blocks[0]?.text ?? '';
        expect(text).toContain('**Articles Returned:** 0');
        expect(text).toContain('No full-text articles returned');
        expect(text).toContain('PMC');
        expect(text).toContain('pubmed_fetch_articles');
      });

      it('renders the unavailable list before the recovery blockquote', () => {
        const blocks = fetchFulltextTool.format!({
          articles: [],
          totalReturned: 0,
          unavailable: [
            {
              id: '31295471',
              idType: 'pmid',
              reason: 'no-doi',
              triedTiers: [{ tier: 'unpaywall', outcome: 'no-doi' }],
            },
          ],
        });

        const text = blocks[0]?.text ?? '';
        const unavailableIdx = text.indexOf('Unavailable (');
        const recoveryIdx = text.indexOf('No full-text articles returned');
        expect(unavailableIdx).toBeGreaterThan(-1);
        expect(recoveryIdx).toBeGreaterThan(unavailableIdx);
      });

      it('does NOT emit the recovery blockquote when articles are present', () => {
        const blocks = fetchFulltextTool.format!({
          articles: [
            {
              source: 'pmc',
              viaSource: 'pmc',
              pmcId: 'PMC1',
              pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/',
              title: 'Real Article',
              authors: [],
              affiliations: [],
              keywords: [],
              sections: [],
              references: [],
            },
          ],
          totalReturned: 1,
        });

        const text = blocks[0]?.text ?? '';
        expect(text).not.toContain('No full-text articles returned');
      });
    });
  });

  describe('format content[] completeness (issue #29)', () => {
    const baseArticle = {
      source: 'pmc' as const,
      viaSource: 'pmc' as const,
      pmcId: 'PMC1',
      pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/',
      title: 'Article',
      authors: [
        { lastName: 'Smith', givenNames: 'Jane' },
        { lastName: 'Jones', givenNames: 'Alex' },
        { lastName: 'Brown', givenNames: 'Sam' },
        { lastName: 'White', givenNames: 'Pat' },
        { collectiveName: 'Consortium X' },
      ],
      journal: { title: 'Nature', issn: '1476-4687', volume: '12', issue: '3', pages: '45-52' },
      sections: [
        {
          title: 'Introduction',
          label: '1',
          text: 'Intro body.',
          subsections: [{ title: 'Background', label: '1.1', text: 'Background.' }],
        },
        { title: 'Methods', text: 'Methods body.' },
      ],
    };

    it('renders every author with givenNames lastName — no et al. truncation', () => {
      const blocks = fetchFulltextTool.format!({ articles: [baseArticle], totalReturned: 1 });
      const text = blocks[0]?.text ?? '';

      expect(text).toContain('**Authors (5):**');
      expect(text).toContain('- Jane Smith');
      expect(text).toContain('- Alex Jones');
      expect(text).toContain('- Sam Brown');
      expect(text).toContain('- Pat White');
      expect(text).toContain('- Consortium X (collective)');
      expect(text).not.toContain('et al.');
    });

    it('renders the journal ISSN alongside other journal fields', () => {
      const blocks = fetchFulltextTool.format!({ articles: [baseArticle], totalReturned: 1 });
      expect(blocks[0]?.text).toContain('ISSN 1476-4687');
    });

    it('prefixes section and subsection headings with the JATS label when present', () => {
      const blocks = fetchFulltextTool.format!({ articles: [baseArticle], totalReturned: 1 });
      const text = blocks[0]?.text ?? '';

      expect(text).toContain('#### 1 Introduction');
      expect(text).toContain('##### 1.1 Background');
      expect(text).toContain('#### Methods');
    });
  });
});
