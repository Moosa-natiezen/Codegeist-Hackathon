import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => {
  const route = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (acc, part, index) => acc + part + (index < values.length ? String(values[index]) : ''),
      '',
    );
  const client = () => ({ requestJira: vi.fn(), requestConfluence: vi.fn() });
  const api = { asUser: client, asApp: client };
  return { default: api, api, route };
});

const { decodeConfluenceTinyKey, pageIdFromRemoteLink, pageIdFromUrl } = await import(
  '../src/backend/contextFetcher'
);

/** Builds the `/wiki/x/<key>` tiny key for a page ID: 64-bit little-endian base64url. */
function tinyKeyFor(pageId: string): string {
  const bytes: number[] = [];
  let remaining = BigInt(pageId);
  while (remaining > 0n) {
    bytes.push(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
  return Buffer.from(bytes).toString('base64url');
}

describe('Confluence tiny links', () => {
  it('decodes the little-endian base64url page ID', () => {
    for (const pageId of ['1001', '98765', '2147483647']) {
      expect(decodeConfluenceTinyKey(tinyKeyFor(pageId))).toBe(pageId);
    }
  });

  it('resolves a /wiki/x/<key> URL to the numeric page ID', () => {
    const url = `https://one-atlas-deuz.atlassian.net/wiki/x/${tinyKeyFor('1001')}`;
    expect(pageIdFromUrl(url)).toBe('1001');
    expect(pageIdFromRemoteLink({ url })).toBe('1001');
  });

  it('rejects keys that are not valid base64url or too long for a page ID', () => {
    expect(decodeConfluenceTinyKey('')).toBeNull();
    expect(decodeConfluenceTinyKey('not*valid')).toBeNull();
    expect(decodeConfluenceTinyKey(Buffer.alloc(1).toString('base64url'))).toBeNull();
    expect(decodeConfluenceTinyKey('AAAAAAAAAAAAAA')).toBeNull();
  });
});

describe('Confluence page IDs from Jira remote links', () => {
  it('reads the page ID from the remote link globalId', () => {
    expect(pageIdFromRemoteLink({ globalId: 'appId=1001&pageId=98765' })).toBe('98765');
    expect(
      pageIdFromRemoteLink({
        globalId: 'ari:cloud:confluence:site/2dac9431-ae6d-461f-a35f-17b42a3b203e:page/4242',
      }),
    ).toBe('4242');
  });

  it('reads the page ID from canonical and query-string URLs', () => {
    expect(
      pageIdFromRemoteLink({
        url: 'https://one-atlas-deuz.atlassian.net/wiki/spaces/ARCH/pages/1001/ADR-014',
      }),
    ).toBe('1001');
    expect(
      pageIdFromRemoteLink({
        url: 'https://one-atlas-deuz.atlassian.net/wiki/pages/viewpage.action?pageId=777',
      }),
    ).toBe('777');
  });

  it('prefers globalId over the URL and returns null when neither carries an ID', () => {
    expect(
      pageIdFromRemoteLink({
        globalId: 'appId=1&pageId=55',
        url: 'https://one-atlas-deuz.atlassian.net/wiki/spaces/ARCH/pages/99',
      }),
    ).toBe('55');
    expect(pageIdFromRemoteLink({ url: 'https://github.com/acme/repo/pull/7' })).toBeNull();
    expect(pageIdFromRemoteLink({})).toBeNull();
  });
});
