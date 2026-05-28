/**
 * @fileoverview Server-specific configuration for NCBI E-utilities.
 * Lazy-parsed from environment variables. Framework config (transport, logging, etc.)
 * is handled by @cyanheads/mcp-ts-core.
 * @module src/config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Treats an unset env var (`undefined`), a set-but-empty env var (`""`), and
 * an unsubstituted MCPB placeholder (`${user_config.X}`) identically. Without
 * this, `NCBI_ADMIN_EMAIL=` would fail `z.email()` validation instead of being
 * interpreted as "no admin email configured". The placeholder case occurs when
 * a Claude Desktop / MCPB host installs the bundle and the user leaves an
 * optional `user_config` field blank — the literal `${user_config.X}` string
 * is passed through to the process instead of being substituted, which would
 * otherwise crash `z.email()` on the next config load.
 */
const PLACEHOLDER_PATTERN = /^\$\{[^}]+\}$/;
const emptyAsUndefined = (v: unknown) => {
  if (v === '') return;
  if (typeof v === 'string' && PLACEHOLDER_PATTERN.test(v)) return;
  return v;
};

/**
 * Parse a string env var as a boolean. `z.coerce.boolean()` is unusable for
 * env vars because it applies JavaScript truthy semantics — `"false"` coerces
 * to `true`. This mirrors the framework's `envBoolean` so `EUROPEPMC_ENABLED=false`
 * actually disables the service.
 */
const envBoolean = z.preprocess((v) => {
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0' || s === '') return false;
  }
  return v;
}, z.boolean());

const ServerConfigSchema = z.object({
  apiKey: z.preprocess(emptyAsUndefined, z.string().optional()).describe('NCBI API key'),
  toolIdentifier: z.string().default('pubmed-mcp-server').describe('NCBI tool identifier'),
  adminEmail: z.preprocess(emptyAsUndefined, z.email().optional()).describe('Admin contact email'),
  requestDelayMs: z.coerce.number().min(50).max(5000).default(334).describe('Request delay in ms'),
  maxConcurrent: z.coerce
    .number()
    .min(1)
    .max(16)
    .default(8)
    .describe('Max concurrent in-flight NCBI requests'),
  maxRetries: z.coerce.number().min(0).max(10).default(6).describe('Max retry attempts'),
  timeoutMs: z.coerce
    .number()
    .min(1000)
    .max(120000)
    .default(30000)
    .describe('Per-request HTTP timeout in ms'),
  totalDeadlineMs: z.coerce
    .number()
    .min(5000)
    .max(600000)
    .default(60000)
    .describe('Total deadline across all retry attempts for one NCBI call, in ms'),
  unpaywallEmail: z
    .preprocess(emptyAsUndefined, z.email().optional())
    .describe('Email for Unpaywall API (enables non-PMC full-text fallback when set)'),
  unpaywallTimeoutMs: z.coerce
    .number()
    .min(1000)
    .max(120000)
    .default(20000)
    .describe('Per-request HTTP timeout for Unpaywall lookups and content fetches, in ms'),
  europepmcEnabled: envBoolean
    .default(true)
    .describe(
      'Enable Europe PMC search tool and `pubmed_fetch_fulltext` JATS fallback chain. Set false to fully disable EPMC calls.',
    ),
  europepmcEmail: z
    .preprocess(emptyAsUndefined, z.email().optional())
    .describe('Optional contact email sent with Europe PMC requests'),
  europepmcRequestDelayMs: z.coerce
    .number()
    .min(50)
    .max(5000)
    .default(200)
    .describe('Minimum gap between Europe PMC request starts in ms'),
  europepmcMaxRetries: z.coerce
    .number()
    .min(0)
    .max(10)
    .default(3)
    .describe('Max retry attempts for failed Europe PMC requests'),
  europepmcTimeoutMs: z.coerce
    .number()
    .min(1000)
    .max(120000)
    .default(20000)
    .describe('Per-request HTTP timeout for Europe PMC calls, in ms'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  if (!_config) {
    const parsed = parseEnvConfig(ServerConfigSchema, {
      apiKey: 'NCBI_API_KEY',
      toolIdentifier: 'NCBI_TOOL_IDENTIFIER',
      adminEmail: 'NCBI_ADMIN_EMAIL',
      requestDelayMs: 'NCBI_REQUEST_DELAY_MS',
      maxConcurrent: 'NCBI_MAX_CONCURRENT',
      maxRetries: 'NCBI_MAX_RETRIES',
      timeoutMs: 'NCBI_TIMEOUT_MS',
      totalDeadlineMs: 'NCBI_TOTAL_DEADLINE_MS',
      unpaywallEmail: 'UNPAYWALL_EMAIL',
      unpaywallTimeoutMs: 'UNPAYWALL_TIMEOUT_MS',
      europepmcEnabled: 'EUROPEPMC_ENABLED',
      europepmcEmail: 'EUROPEPMC_EMAIL',
      europepmcRequestDelayMs: 'EUROPEPMC_REQUEST_DELAY_MS',
      europepmcMaxRetries: 'EUROPEPMC_MAX_RETRIES',
      europepmcTimeoutMs: 'EUROPEPMC_TIMEOUT_MS',
    });
    /**
     * An API key raises NCBI's rate ceiling from ~3 req/s to ~10 req/s. If the
     * operator hasn't explicitly overridden the delay, tighten from the 334ms
     * safe default to 100ms when a key is present.
     */
    _config =
      parsed.apiKey && process.env.NCBI_REQUEST_DELAY_MS === undefined
        ? { ...parsed, requestDelayMs: 100 }
        : parsed;
  }
  return _config;
}
