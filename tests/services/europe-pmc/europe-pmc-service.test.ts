/**
 * @fileoverview Tests for the Europe PMC service.
 * @module tests/services/europe-pmc/europe-pmc-service.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@cyanheads/mcp-ts-core/utils');
  return {
    ...actual,
    fetchWithTimeout: mockFetchWithTimeout,
  };
});

const { EuropePmcApiClient } = await import('@/services/europe-pmc/api-client.js');
const { EuropePmcRequestQueue } = await import('@/services/europe-pmc/request-queue.js');
const { EuropePmcService } = await import('@/services/europe-pmc/europe-pmc-service.js');

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function xmlResponse(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/xml' },
    ...init,
  });
}

function makeService(opts: { maxRetries?: number; minStartGapMs?: number } = {}) {
  const client = new EuropePmcApiClient({ timeoutMs: 20000 });
  const queue = new EuropePmcRequestQueue(opts.minStartGapMs ?? 0);
  return new EuropePmcService(client, queue, opts.maxRetries ?? 0);
}

describe('EuropePmcService.search', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it('parses a normal search response and exposes cursor pagination', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 42,
        nextCursorMark: 'NEXT_CURSOR',
        request: { cursorMark: '*', queryString: 'foo AND (SRC:"MED")' },
        resultList: {
          result: [
            {
              id: '1',
              source: 'MED',
              pmid: '1',
              title: 'A paper',
              doi: '10.1/x',
              isOpenAccess: 'Y',
              inEPMC: 'Y',
              abstractText: 'Abstract',
              firstPublicationDate: '2025-01-02',
            },
          ],
        },
      }),
    );

    const service = makeService();
    const result = await service.search({
      query: 'foo',
      sources: ['MED'],
      pageSize: 25,
      cursorMark: '*',
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.source).toBe('MED');
    expect(result.hitCount).toBe(42);
    expect(result.nextCursorMark).toBe('NEXT_CURSOR');
    expect(result.cursorMark).toBe('*');
  });

  it('normalizes a single-hit response (scalar `result`, not array)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 1,
        request: { cursorMark: '*' },
        resultList: { result: { id: 'PPR1', source: 'PPR', doi: '10.21203/x' } },
      }),
    );

    const service = makeService();
    const result = await service.search({ query: 'preprint', sources: ['PPR'] });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.id).toBe('PPR1');
  });

  it('omits `nextCursorMark` when EPMC echoes the same cursor (final page sentinel)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 1,
        nextCursorMark: 'CURSOR_X',
        request: { cursorMark: 'CURSOR_X' },
        resultList: { result: [{ id: '7', source: 'PMC' }] },
      }),
    );

    const service = makeService();
    const result = await service.search({ query: 'foo', cursorMark: 'CURSOR_X' });
    expect(result.nextCursorMark).toBeUndefined();
  });

  it('builds query with source filter when sources are provided', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ hitCount: 0 }));

    const service = makeService();
    await service.search({ query: 'cancer', sources: ['MED', 'PMC', 'PPR'] });

    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('(cancer)');
    expect(decoded).toContain('SRC:"MED"');
    expect(decoded).toContain('SRC:"PMC"');
    expect(decoded).toContain('SRC:"PPR"');
  });

  it('sends an unfiltered query when sources is omitted', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ hitCount: 0 }));
    const service = makeService();
    await service.search({ query: 'cancer' });
    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).not.toContain('SRC:');
  });

  it('URL-encodes a DOI query so slashes survive', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ hitCount: 0 }));
    const service = makeService();
    await service.search({ query: 'DOI:"10.21203/rs.3.rs-9010375/v1"' });
    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    expect(url).toContain('10.21203%2Frs.3.rs-9010375%2Fv1');
  });

  it('throws SerializationError on non-JSON body', async () => {
    mockFetchWithTimeout.mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));
    const service = makeService();
    await expect(service.search({ query: 'foo' })).rejects.toMatchObject({
      data: { reason: 'europepmc_invalid_response' },
    });
  });

  it('throws ServiceUnavailable on 5xx', async () => {
    mockFetchWithTimeout.mockResolvedValue(new Response('down', { status: 503 }));
    const service = makeService();
    await expect(service.search({ query: 'foo' })).rejects.toThrow(/503/);
  });

  it('throws ServiceUnavailable with europepmc_unreachable on network failure', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const service = makeService();
    await expect(service.search({ query: 'foo' })).rejects.toMatchObject({
      data: {
        reason: 'europepmc_unreachable',
        recovery: { hint: expect.stringContaining('Europe PMC was unreachable') },
      },
    });
  });
});

describe('EuropePmcService.fullTextXml', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it('returns `found` with raw XML on 200', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      xmlResponse('<?xml version="1.0"?><article><body>hi</body></article>'),
    );
    const service = makeService();
    const result = await service.fullTextXml('PPR1', 'PPR');
    expect(result).toEqual({
      kind: 'found',
      xml: '<?xml version="1.0"?><article><body>hi</body></article>',
      epmcId: 'PPR1',
      source: 'PPR',
    });
  });

  it('returns `not-available` for 404', async () => {
    mockFetchWithTimeout.mockResolvedValue(new Response('nope', { status: 404 }));
    const service = makeService();
    const result = await service.fullTextXml('PPR404', 'PPR');
    expect(result.kind).toBe('not-available');
  });

  it('returns `not-available` for an empty 200 body (issue safety net)', async () => {
    mockFetchWithTimeout.mockResolvedValue(xmlResponse('   '));
    const service = makeService();
    const result = await service.fullTextXml('EMPTY1', 'PMC');
    expect(result.kind).toBe('not-available');
  });

  it('throws ServiceUnavailable on 5xx', async () => {
    mockFetchWithTimeout.mockResolvedValue(new Response('down', { status: 503 }));
    const service = makeService();
    await expect(service.fullTextXml('X', 'PMC')).rejects.toThrow(/503/);
  });

  it('uses the single-id URL pattern, not source/id', async () => {
    mockFetchWithTimeout.mockResolvedValue(xmlResponse('<article/>'));
    const service = makeService();
    await service.fullTextXml('PPR123', 'PPR');
    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    expect(url).toMatch(/\/PPR123\/fullTextXML$/);
    expect(url).not.toContain('/PPR/PPR123/');
  });
});

describe('EuropePmcService.parseFullTextXml', () => {
  it('parses well-formed JATS into an article JatsNode', () => {
    const service = makeService();
    const xml = `<?xml version="1.0"?>
<article article-type="research-article">
  <front><article-meta><title-group><article-title>Hi</article-title></title-group></article-meta></front>
  <body><sec><title>Intro</title><p>Body</p></sec></body>
</article>`;
    const node = service.parseFullTextXml(xml);
    expect(node).toBeDefined();
    expect(node && 'article' in node).toBe(true);
  });

  it('returns undefined when the body has no <article>', () => {
    const service = makeService();
    const xml = `<?xml version="1.0"?><wrapper><note>nothing here</note></wrapper>`;
    const node = service.parseFullTextXml(xml);
    expect(node).toBeUndefined();
  });

  it('throws SerializationError on malformed XML', () => {
    const service = makeService();
    expect(() => service.parseFullTextXml('<article><body>')).toThrowError(
      /invalid XML from Europe PMC/i,
    );
  });
});

describe('initEuropePmcService / getEuropePmcService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('leaves the service unset when EUROPEPMC_ENABLED=false', async () => {
    vi.stubEnv('EUROPEPMC_ENABLED', 'false');

    const mod = await import('@/services/europe-pmc/europe-pmc-service.js');
    mod.initEuropePmcService();
    expect(mod.getEuropePmcService()).toBeUndefined();
  });

  it('constructs the service when EUROPEPMC_ENABLED=true (default)', async () => {
    delete process.env.EUROPEPMC_ENABLED;

    const mod = await import('@/services/europe-pmc/europe-pmc-service.js');
    mod.initEuropePmcService();
    expect(mod.getEuropePmcService()).toBeInstanceOf(mod.EuropePmcService);
  });

  it('leaves the service unset when EUROPEPMC_ENABLED=0', async () => {
    vi.stubEnv('EUROPEPMC_ENABLED', '0');

    const mod = await import('@/services/europe-pmc/europe-pmc-service.js');
    mod.initEuropePmcService();
    expect(mod.getEuropePmcService()).toBeUndefined();
  });
});
