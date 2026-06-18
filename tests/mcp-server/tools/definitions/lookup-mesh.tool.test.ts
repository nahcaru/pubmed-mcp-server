/**
 * @fileoverview Tests for the lookup-mesh tool.
 * @module tests/mcp-server/tools/definitions/lookup-mesh.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockESearch = vi.fn();
const mockESummary = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eSearch: mockESearch, eSummary: mockESummary }),
}));

const { lookupMeshTool } = await import('@/mcp-server/tools/definitions/lookup-mesh.tool.js');

describe('lookupMeshTool', () => {
  beforeEach(() => {
    mockESearch.mockReset();
    mockESummary.mockReset();
  });

  it('validates input with defaults', () => {
    const input = lookupMeshTool.input.parse({ query: 'Neoplasms' });
    expect(input.query).toBe('Neoplasms');
    expect(input.maxResults).toBe(10);
    expect(input.includeDetails).toBe(true);
  });

  it('returns empty results with a recovery notice when no MeSH IDs found', async () => {
    mockESearch.mockResolvedValue({ idList: [] });

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({ query: 'xyznonexistent' });
    const result = await lookupMeshTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.results).toEqual([]);
    expect(result.query).toBe('xyznonexistent');
    expect(enrichment.notice).toMatch(/xyznonexistent/);
    expect(enrichment.notice).toMatch(/spell_check|search_articles/);
  });

  it('returns parsed MeSH records', async () => {
    mockESearch.mockResolvedValue({ idList: ['68009369'] });
    mockESummary.mockResolvedValue({
      eSummaryResult: {
        DocSum: [
          {
            Id: '68009369',
            Item: [
              {
                '@_Name': 'DS_MeshTerms',
                '@_Type': 'List',
                Item: [{ '@_Name': 'string', '@_Type': 'String', '#text': 'Neoplasms' }],
              },
              {
                '@_Name': 'DS_ScopeNote',
                '@_Type': 'String',
                '#text': 'New abnormal growth of tissue.',
              },
            ],
          },
        ],
      },
    });

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({ query: 'Neoplasms' });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.meshId).toBe('D009369');
    expect(result.results[0]?.entrezUid).toBe('68009369');
    expect(result.results[0]?.name).toBe('Neoplasms');
    expect(result.results[0]?.scopeNote).toContain('abnormal growth');
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('deduplicates exact matches, respects maxResults, and parses detailed tree metadata', async () => {
    mockESearch.mockImplementation(async (params: { term: string }) => {
      if (params.term.endsWith('[MH]')) return { idList: ['68009369'] };
      return { idList: ['68001234', '68009369', '68009999'] };
    });
    mockESummary.mockResolvedValue({
      eSummaryResult: {
        DocSum: [
          {
            Id: '68001234',
            Item: [
              {
                '@_Name': 'DS_MeshTerms',
                Item: [{ '#text': 'Cancer' }],
              },
            ],
          },
          {
            Id: '68009369',
            Item: [
              {
                '@_Name': 'DS_MeshTerms',
                '@_Type': 'List',
                Item: [{ '#text': 'Neoplasms' }, { '#text': 'Tumors' }],
              },
              {
                '@_Name': 'DS_ScopeNote',
                '#text': 'New abnormal growth of tissue.',
              },
              {
                '@_Name': 'DS_IdxLinks',
                Item: [
                  { Item: [{ '@_Name': 'TreeNum', '#text': 'C04' }] },
                  { Item: [{ '@_Name': 'TreeNum', '#text': 'C04.588' }] },
                  { Item: [{ '@_Name': 'DescriptorUI', '#text': 'D009369' }] },
                ],
              },
            ],
          },
        ],
      },
    });

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({ query: 'Neoplasms', maxResults: 2 });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(mockESearch).toHaveBeenCalledWith(
      { db: 'mesh', term: 'Neoplasms', retmax: 2 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockESearch).toHaveBeenCalledWith(
      { db: 'mesh', term: 'Neoplasms[MH]', retmax: 1 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockESummary).toHaveBeenCalledWith(
      { db: 'mesh', id: '68009369,68001234' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.results.map((r) => r.meshId)).toEqual(['D009369', 'D001234']);
    expect(result.results.map((r) => r.entrezUid)).toEqual(['68009369', '68001234']);
    expect(result.results[0]).toMatchObject({
      entrezUid: '68009369',
      name: 'Neoplasms',
      scopeNote: 'New abnormal growth of tissue.',
      entryTerms: ['Neoplasms', 'Tumors'],
      treeNumbers: ['C04', 'C04.588'],
    });
  });

  it('filters non-navigable @-pointer "tree numbers" from SCRs (#76)', async () => {
    mockESearch.mockImplementation(async (params: { term: string }) =>
      params.term.endsWith('[MH]') ? { idList: [] } : { idList: ['67585596', '68008687'] },
    );
    mockESummary.mockResolvedValue({
      eSummaryResult: {
        DocSum: [
          {
            // Supplementary Concept Record (Jentadueto): TreeNum is a mapped-heading
            // pointer (@-prefixed), not a navigable tree number.
            Id: '67585596',
            Item: [
              { '@_Name': 'DS_MeshTerms', Item: [{ '#text': 'Jentadueto' }] },
              {
                '@_Name': 'DS_IdxLinks',
                Item: [{ Item: [{ '@_Name': 'TreeNum', '#text': '@218176' }] }],
              },
            ],
          },
          {
            // True descriptor (Metformin): a real tree number plus a stray @-pointer
            // that must still be dropped.
            Id: '68008687',
            Item: [
              { '@_Name': 'DS_MeshTerms', Item: [{ '#text': 'Metformin' }] },
              {
                '@_Name': 'DS_IdxLinks',
                Item: [
                  { Item: [{ '@_Name': 'TreeNum', '#text': 'D02.078.370.141.450' }] },
                  { Item: [{ '@_Name': 'TreeNum', '#text': '@218176' }] },
                ],
              },
            ],
          },
        ],
      },
    });

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({ query: 'metformin' });
    const result = await lookupMeshTool.handler(input, ctx);

    const jentadueto = result.results.find((r) => r.entrezUid === '67585596');
    const metformin = result.results.find((r) => r.entrezUid === '68008687');
    // SCR with only an @-pointer → treeNumbers omitted entirely.
    expect(jentadueto?.treeNumbers).toBeUndefined();
    // Descriptor keeps the real tree number; the @-pointer is filtered out.
    expect(metformin?.treeNumbers).toEqual(['D02.078.370.141.450']);
  });

  it('skips exact MeSH search for tagged queries and omits details when requested', async () => {
    mockESearch.mockResolvedValue({ idList: ['68009369'] });
    mockESummary.mockResolvedValue({
      DocSum: {
        Id: '68009369',
        Item: [
          {
            '@_Name': 'DS_MeshTerms',
            Item: [{ '#text': 'Neoplasms' }, { '#text': 'Tumors' }],
          },
          { '@_Name': 'DS_ScopeNote', '#text': 'New abnormal growth of tissue.' },
        ],
      },
    });

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({
      query: 'Neoplasms[MH]',
      includeDetails: false,
    });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(mockESearch).toHaveBeenCalledTimes(1);
    expect(mockESearch).toHaveBeenCalledWith(
      { db: 'mesh', term: 'Neoplasms[MH]', retmax: 10 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.results).toEqual([
      { entrezUid: '68009369', meshId: 'D009369', name: 'Neoplasms' },
    ]);
  });

  it('falls back to requested IDs when ESummary returns no records', async () => {
    mockESearch.mockImplementation(async (params: { term: string }) =>
      params.term.endsWith('[MH]') ? { idList: [] } : { idList: ['68000001'] },
    );
    mockESummary.mockResolvedValue({});

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({ query: 'rare descriptor' });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(result.results).toEqual([
      { entrezUid: '68000001', meshId: 'D000001', name: '68000001' },
    ]);
  });

  it('decodes Entrez mesh UIDs to canonical DescriptorUIs and keeps the raw UID; non-decodable UIDs fall back', async () => {
    mockESearch.mockImplementation(async (params: { term: string }) =>
      params.term.endsWith('[MH]')
        ? { idList: [] }
        : { idList: ['68003924', '67000123', '81000628', '2025952'] },
    );
    mockESummary.mockResolvedValue({
      eSummaryResult: {
        DocSum: [
          {
            Id: '68003924',
            Item: [{ '@_Name': 'DS_MeshTerms', Item: [{ '#text': 'Diabetes Mellitus, Type 2' }] }],
          },
          {
            Id: '67000123',
            Item: [{ '@_Name': 'DS_MeshTerms', Item: [{ '#text': 'Some Supplementary Concept' }] }],
          },
          {
            Id: '81000628',
            Item: [{ '@_Name': 'DS_MeshTerms', Item: [{ '#text': 'Therapeutic Use' }] }],
          },
          {
            Id: '2025952',
            Item: [{ '@_Name': 'DS_MeshTerms', Item: [{ '#text': 'tisagenlecleucel' }] }],
          },
        ],
      },
    });

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({ query: 'mixed batch', includeDetails: false });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(result.results.map((r) => ({ meshId: r.meshId, entrezUid: r.entrezUid }))).toEqual([
      { meshId: 'D003924', entrezUid: '68003924' }, // descriptor (D = 68)
      { meshId: 'C000123', entrezUid: '67000123' }, // supplementary concept (C = 67)
      { meshId: 'Q000628', entrezUid: '81000628' }, // qualifier (Q = 81)
      { meshId: '2025952', entrezUid: '2025952' }, // non-decodable sequential UID → raw
    ]);
  });

  it('formats output', () => {
    const blocks = lookupMeshTool.format!({
      query: 'Neoplasms',
      results: [
        {
          entrezUid: '68009369',
          meshId: 'D009369',
          name: 'Neoplasms',
          scopeNote: 'New abnormal growth of tissue.',
          treeNumbers: ['C04'],
        },
      ],
    });
    expect(blocks[0]?.text).toContain('MeSH Lookup');
    expect(blocks[0]?.text).toContain('Neoplasms');
    expect(blocks[0]?.text).toContain('C04');
    expect(blocks[0]?.text).toContain('D009369');
    expect(blocks[0]?.text).toContain('Entrez UID');
    expect(blocks[0]?.text).toContain('68009369');
  });

  it('renders empty results; the recovery notice is enrichment, not format output', () => {
    const blocks = lookupMeshTool.format!({
      query: 'xyznonexistent',
      results: [],
    });
    expect(blocks[0]?.text).toContain('Found **0** result(s).');
  });
});
