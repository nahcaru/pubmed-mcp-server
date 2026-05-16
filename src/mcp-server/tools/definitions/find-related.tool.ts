/**
 * @fileoverview PubMed related articles tool — finds articles related to a
 * source article via NCBI ELink and enriches results with ESummary data.
 * @module src/mcp-server/tools/definitions/find-related.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { NCBI_SERVICE_ERRORS } from '@/services/error-contracts.js';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { extractBriefSummaries } from '@/services/ncbi/parsing/esummary-parser.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
import type { ParsedBriefSummary } from '@/services/ncbi/types.js';
import { conceptMeta, EDAM_DATA_RETRIEVAL, SCHEMA_SCHOLARLY_ARTICLE } from './_concepts.js';
import { pmidStringSchema } from './_schemas.js';

// ─── ELink XML types ─────────────────────────────────────────────────────────

interface XmlELinkItem {
  Id: string | number | { '#text'?: string | number };
}

interface ELinkLinkSetDb {
  Link?: XmlELinkItem | XmlELinkItem[];
  LinkName?: string;
}

interface ELinkResultItem {
  LinkSet?: { LinkSetDb?: ELinkLinkSetDb | ELinkLinkSetDb[] };
}

interface ELinkResponse {
  eLinkResult?: ELinkResultItem | ELinkResultItem[];
}

function extractValue(field: string | number | { '#text'?: string | number } | undefined): string {
  if (field === undefined || field === null) return '';
  if (typeof field === 'object') return field['#text'] !== undefined ? String(field['#text']) : '';
  return String(field);
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

export const findRelatedTool = tool('pubmed_find_related', {
  description:
    'Find articles related to a source article — similar content, citing articles, or references.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SCHOLARLY_ARTICLE, EDAM_DATA_RETRIEVAL]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/find-related.tool.ts',

  errors: [...NCBI_SERVICE_ERRORS] as const,

  input: z.object({
    pmid: pmidStringSchema.describe('Source PubMed ID'),
    relationship: z
      .enum(['similar', 'cited_by', 'references'])
      .default('similar')
      .describe(
        'Relationship type: similar (content-based), cited_by (articles citing this one), references (articles this one cites)',
      ),
    maxResults: z.number().int().min(1).max(50).default(10).describe('Maximum related articles'),
  }),

  output: z.object({
    sourcePmid: z.string().describe('Source PubMed ID'),
    relationship: z.enum(['similar', 'cited_by', 'references']).describe('Relationship type used'),
    articles: z
      .array(
        z
          .object({
            pmid: z.string().describe('PubMed ID'),
            title: z.string().optional().describe('Article title'),
            authors: z.string().optional().describe('Author string'),
            source: z.string().optional().describe('Journal source'),
            pubDate: z.string().optional().describe('Publication date'),
          })
          .describe('Related article with enriched summary'),
      )
      .describe('Related articles'),
    totalFound: z.number().describe('Total related articles found before truncation'),
    notice: z
      .string()
      .optional()
      .describe(
        'Optional guidance when results are empty — e.g. invalid source PMID, or references requested for a non-PMC source. Absent on successful result pages.',
      ),
  }),

  async handler(input, ctx) {
    const ncbi = getNcbiService();
    ctx.log.debug('Finding related articles', {
      pmid: input.pmid,
      relationship: input.relationship,
    });

    // `cmd=neighbor_score` is unstable on NCBI's side — it intermittently fails
    // with a TXCLIENT::readAll EOF for high-traffic PMIDs. `cmd=neighbor` returns
    // the `pubmed_pubmed` list in relevance order anyway, so we keep the ranking
    // without the (arbitrary-scale) numeric score.
    const linkName =
      input.relationship === 'cited_by'
        ? 'pubmed_pubmed_citedin'
        : input.relationship === 'references'
          ? 'pubmed_pubmed_refs'
          : 'pubmed_pubmed';

    const eLinkResult = (await ncbi.eLink(
      {
        dbfrom: 'pubmed',
        db: 'pubmed',
        id: input.pmid,
        cmd: 'neighbor',
        linkname: linkName,
        retmode: 'xml',
      },
      { signal: ctx.signal },
    )) as ELinkResponse;
    const eLinkResultsArray = ensureArray(eLinkResult?.eLinkResult);
    const firstResult = eLinkResultsArray[0] as ELinkResultItem | undefined;
    const linkSet = firstResult?.LinkSet;
    let foundPmids: string[] = [];

    if (linkSet?.LinkSetDb) {
      const linkSetDbArray = ensureArray(linkSet.LinkSetDb);
      const targetDb = linkSetDbArray.find((db) => db.LinkName === linkName) ?? linkSetDbArray[0];

      if (targetDb?.Link) {
        foundPmids = ensureArray(targetDb.Link)
          .map((link: XmlELinkItem) => extractValue(link.Id))
          .filter((pmid) => pmid && pmid !== input.pmid && pmid !== '0');
      }
    }

    const totalFound = foundPmids.length;
    if (foundPmids.length === 0) {
      // ELink returns an empty LinkSet for both invalid source PMIDs and valid
      // PMIDs that simply have no related articles, so a single ESummary on the
      // source disambiguates the two cases for every relationship type. NCBI's
      // pubmed_pubmed_refs ELink also only resolves references for PMC-indexed
      // sources, so the same lookup yields the PMCID for the references hint.
      let sourceSummary: ParsedBriefSummary | undefined;
      let sourceConfirmedMissing = false;
      try {
        const summaryResult = await ncbi.eSummary(
          { db: 'pubmed', id: input.pmid },
          { signal: ctx.signal },
        );
        const summaries = await extractBriefSummaries(summaryResult);
        sourceSummary = summaries[0];
        // ESummary succeeded but returned nothing parseable — PMID is unknown.
        if (!sourceSummary?.title) sourceConfirmedMissing = true;
      } catch (err) {
        ctx.log.debug('Source PMID ESummary failed', { err });
        // Key off the contract reason rather than the JSON-RPC code: the service
        // layer stamps `ncbi_resource_not_found` for "unknown UID" responses,
        // while transient transport failures keep their ServiceUnavailable code
        // with no such reason.
        const reason =
          err instanceof McpError
            ? (err.data as { reason?: string } | undefined)?.reason
            : undefined;
        if (reason === 'ncbi_resource_not_found') {
          sourceConfirmedMissing = true;
        }
      }

      let notice: string | undefined;
      if (sourceConfirmedMissing) {
        notice = `Source PMID ${input.pmid} not found in PubMed. Verify the ID with \`pubmed_fetch_articles\` or \`pubmed_search_articles\`.`;
      } else if (sourceSummary?.title && input.relationship === 'references') {
        const sourcePmcId = sourceSummary.pmcId;
        notice = sourcePmcId
          ? `No reference list found in PMC for PMID ${input.pmid} (PMCID ${sourcePmcId}).`
          : `Reference lists require the source article to be indexed in PMC. PMID ${input.pmid} has no PMCID — references unavailable. Use pubmed_fetch_articles to inspect the article record, or try relationship: "similar" / "cited_by".`;
      }

      return {
        sourcePmid: input.pmid,
        relationship: input.relationship,
        articles: [],
        totalFound: 0,
        ...(notice && { notice }),
      };
    }

    const pmidsToEnrich = foundPmids.slice(0, input.maxResults);
    const summaryResult = await ncbi.eSummary(
      {
        db: 'pubmed',
        id: pmidsToEnrich.join(','),
      },
      { signal: ctx.signal },
    );
    const briefSummaries = await extractBriefSummaries(summaryResult);
    const summaryMap = new Map(briefSummaries.map((bs) => [bs.pmid, bs]));

    const articles = pmidsToEnrich.map((pmid) => {
      const details = summaryMap.get(pmid);
      return {
        pmid,
        title: details?.title,
        authors: details?.authors,
        source: details?.source,
        pubDate: details?.pubDate,
      };
    });

    return { sourcePmid: input.pmid, relationship: input.relationship, articles, totalFound };
  },

  format: (result) => {
    const lines = [
      `# Related Articles for PMID ${result.sourcePmid}`,
      `**Relationship:** ${result.relationship} | **Found:** ${result.totalFound}`,
    ];
    if (result.notice) lines.push(`\n> ${result.notice}`);
    if (result.articles.length === 0) {
      if (!result.notice) lines.push('No related articles found.');
    } else {
      for (const a of result.articles) {
        lines.push(`- **[PMID ${a.pmid}](https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/)**`);
        if (a.title) lines.push(`  ${a.title}`);
        if (a.authors) lines.push(`  *${a.authors}*`);
        const meta = [a.source, a.pubDate].filter(Boolean).join(', ');
        if (meta) lines.push(`  ${meta}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
