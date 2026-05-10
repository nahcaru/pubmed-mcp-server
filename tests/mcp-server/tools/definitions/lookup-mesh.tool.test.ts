/**
 * @fileoverview Tests for the lookup-mesh tool.
 * @module tests/mcp-server/tools/definitions/lookup-mesh.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

    expect(result.results).toEqual([]);
    expect(result.query).toBe('xyznonexistent');
    expect(result.notice).toMatch(/xyznonexistent/);
    expect(result.notice).toMatch(/spell_check|search_articles/);
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
    expect(result.results[0]?.meshId).toBe('68009369');
    expect(result.results[0]?.name).toBe('Neoplasms');
    expect(result.results[0]?.scopeNote).toContain('abnormal growth');
    expect(result.notice).toBeUndefined();
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
    expect(result.results.map((r) => r.meshId)).toEqual(['68009369', '68001234']);
    expect(result.results[0]).toMatchObject({
      name: 'Neoplasms',
      scopeNote: 'New abnormal growth of tissue.',
      entryTerms: ['Neoplasms', 'Tumors'],
      treeNumbers: ['C04', 'C04.588'],
    });
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
    expect(result.results).toEqual([{ meshId: '68009369', name: 'Neoplasms' }]);
  });

  it('falls back to requested IDs when ESummary returns no records', async () => {
    mockESearch.mockImplementation(async (params: { term: string }) =>
      params.term.endsWith('[MH]') ? { idList: [] } : { idList: ['68000001'] },
    );
    mockESummary.mockResolvedValue({});

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({ query: 'rare descriptor' });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(result.results).toEqual([{ meshId: '68000001', name: '68000001' }]);
  });

  it('formats output', () => {
    const blocks = lookupMeshTool.format!({
      query: 'Neoplasms',
      results: [
        {
          meshId: '68009369',
          name: 'Neoplasms',
          scopeNote: 'New abnormal growth of tissue.',
          treeNumbers: ['C04'],
        },
      ],
    });
    expect(blocks[0]?.text).toContain('MeSH Lookup');
    expect(blocks[0]?.text).toContain('Neoplasms');
    expect(blocks[0]?.text).toContain('C04');
  });

  it('renders the recovery notice in formatted output', () => {
    const blocks = lookupMeshTool.format!({
      query: 'xyznonexistent',
      results: [],
      notice: 'No MeSH descriptors matched "xyznonexistent". Try `pubmed_spell_check`.',
    });
    expect(blocks[0]?.text).toContain('Found **0** result(s).');
    expect(blocks[0]?.text).toContain('pubmed_spell_check');
  });
});
