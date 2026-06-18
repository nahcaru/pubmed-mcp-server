/**
 * @fileoverview Tests for plain-text normalization helpers.
 * @module tests/services/ncbi/parsing/text-helpers.test
 */

import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, toDisplayText } from '@/services/ncbi/parsing/text-helpers.js';

describe('decodeHtmlEntities', () => {
  it('decodes the core named XML entities', () => {
    expect(decodeHtmlEntities('CSR&amp;D')).toBe('CSR&D');
    expect(decodeHtmlEntities('a &lt;b&gt; c &quot;d&quot; &apos;e&apos;')).toBe(
      'a <b> c "d" \'e\'',
    );
  });

  it('decodes decimal and hex numeric references', () => {
    expect(decodeHtmlEntities('en&#8211;dash')).toBe('en–dash');
    expect(decodeHtmlEntities('hex&#x2013;dash')).toBe('hex–dash');
    expect(decodeHtmlEntities('beta &#x3b2;')).toBe('beta β');
  });

  it('collapses an NCBI double-encoded ampersand left by one parser pass', () => {
    // EFetch ships `CSR&amp;amp;D`; the XML parser decodes once to `CSR&amp;D`,
    // and this second pass yields the display form. (#74)
    expect(decodeHtmlEntities('CSR&amp;D I01CX002210')).toBe('CSR&D I01CX002210');
  });

  it('leaves a bare ampersand untouched (idempotent on already-decoded text)', () => {
    expect(decodeHtmlEntities('AT&T')).toBe('AT&T');
    expect(decodeHtmlEntities('CSR&D')).toBe('CSR&D');
  });

  it('leaves unknown named entities and malformed references intact', () => {
    expect(decodeHtmlEntities('&notarealentity;')).toBe('&notarealentity;');
    expect(decodeHtmlEntities('&#xZZ;')).toBe('&#xZZ;');
  });
});

describe('toDisplayText', () => {
  it('strips JATS/HTML structural tags and collapses the gaps', () => {
    expect(toDisplayText('<h4>Background: </h4> Emergency department triage')).toBe(
      'Background: Emergency department triage',
    );
    expect(toDisplayText('<title>Abstract</title>  <p>  <bold>Background:</bold>  text')).toBe(
      'Abstract Background: text',
    );
  });

  it('decodes entities after stripping tags', () => {
    expect(toDisplayText('Emergency &amp; care &lt;LLMs&gt;')).toBe('Emergency & care <LLMs>');
  });

  it('removes soft hyphens (literal and entity-encoded) that corrupt mid-word tokens', () => {
    expect(toDisplayText('clini­cal gen­eration')).toBe('clinical generation');
    expect(toDisplayText('soft&shy;hyphen')).toBe('softhyphen');
  });

  it('returns empty string for a markup-only input', () => {
    expect(toDisplayText('<p></p>')).toBe('');
  });
});
