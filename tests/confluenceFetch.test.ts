import { beforeEach, describe, expect, it, vi } from 'vitest';

const forgeMocks = vi.hoisted(() => {
  const state = { asUserThrows: false };
  const userConfluence = vi.fn();
  const appConfluence = vi.fn();
  const api = {
    asUser: () => {
      // Forge throws this before the user has granted consent for the app.
      if (state.asUserThrows) throw new Error('NEEDS_AUTHENTICATION_ERR');
      return { requestJira: vi.fn(), requestConfluence: userConfluence };
    },
    asApp: () => ({ requestJira: vi.fn(), requestConfluence: appConfluence }),
  };
  // Mirrors the Forge `route` template helper: a template tag that returns the path.
  const route = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (acc, part, index) => acc + part + (index < values.length ? String(values[index]) : ''),
      '',
    );
  return { api, route, userConfluence, appConfluence, state };
});

vi.mock('@forge/api', () => ({
  default: forgeMocks.api,
  api: forgeMocks.api,
  route: forgeMocks.route,
}));

const { fetchConfluencePage, sanitizeCqlTerm } = await import('../src/backend/contextFetcher');

const pageBody = {
  id: '1001',
  title: 'ADR-014 Event Contracts',
  body: { storage: { value: '<p>Must validate payloads before publish</p>' } },
};
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const notFound = { ok: false, status: 404, json: async () => ({}) };

describe('Confluence page fetch fallbacks', () => {
  beforeEach(() => {
    forgeMocks.state.asUserThrows = false;
    forgeMocks.userConfluence.mockReset();
    forgeMocks.appConfluence.mockReset();
  });

  it('reads the v2 storage-format endpoint as the user first', async () => {
    forgeMocks.userConfluence.mockResolvedValue(ok(pageBody));

    const page = await fetchConfluencePage('1001');

    expect(page.title).toBe('ADR-014 Event Contracts');
    expect(forgeMocks.userConfluence).toHaveBeenCalledTimes(1);
    expect(forgeMocks.userConfluence.mock.calls[0][0]).toContain('/wiki/api/v2/pages/1001');
    expect(forgeMocks.appConfluence).not.toHaveBeenCalled();
  });

  it('falls back from the v2 page endpoint to v1 content for the same identity', async () => {
    forgeMocks.userConfluence.mockResolvedValueOnce(notFound).mockResolvedValueOnce(ok(pageBody));

    const page = await fetchConfluencePage('1001');

    expect(page.id).toBe('1001');
    expect(forgeMocks.userConfluence.mock.calls[1][0]).toContain(
      '/wiki/rest/api/content/1001?expand=body.storage',
    );
    expect(forgeMocks.appConfluence).not.toHaveBeenCalled();
  });

  it('falls back from the user identity to the app identity', async () => {
    forgeMocks.userConfluence.mockRejectedValue(new Error('user token refused'));
    forgeMocks.appConfluence.mockResolvedValue(ok(pageBody));

    const page = await fetchConfluencePage('1001');

    expect(page.title).toBe('ADR-014 Event Contracts');
    expect(forgeMocks.appConfluence.mock.calls[0][0]).toContain('/wiki/api/v2/pages/1001');
  });

  it('falls back to the app when api.asUser() itself throws NEEDS_AUTHENTICATION_ERR', async () => {
    forgeMocks.state.asUserThrows = true;
    forgeMocks.appConfluence.mockResolvedValue(ok(pageBody));

    const page = await fetchConfluencePage('1001');

    expect(page.title).toBe('ADR-014 Event Contracts');
    expect(forgeMocks.userConfluence).not.toHaveBeenCalled();
    expect(forgeMocks.appConfluence.mock.calls[0][0]).toContain('/wiki/api/v2/pages/1001');
  });

  it('turns an all-401/403 refusal into actionable sharing guidance', async () => {
    const unauthorized = { ok: false, status: 401, json: async () => ({}) };
    const forbidden = { ok: false, status: 403, json: async () => ({}) };
    forgeMocks.userConfluence.mockResolvedValue(unauthorized);
    forgeMocks.appConfluence.mockResolvedValue(forbidden);

    await expect(fetchConfluencePage('5177345')).rejects.toThrow(
      /Confluence page 5177345 is restricted \(HTTP 401\/403\)\. Open the ADR page, click Share/,
    );
  });

  it('reports every attempt when the page cannot be read at all', async () => {
    forgeMocks.userConfluence.mockResolvedValue(notFound);
    forgeMocks.appConfluence.mockResolvedValue(notFound);

    await expect(fetchConfluencePage('1001')).rejects.toThrow(
      /Confluence page 1001 could not be read/,
    );
  });
});

describe('CQL title sanitization', () => {
  it('collapses reserved characters so a title term cannot break the query', () => {
    expect(sanitizeCqlTerm('ADR-014: Event "Contracts" (v2)*')).toBe(
      'ADR 014 Event Contracts v2',
    );
    expect(sanitizeCqlTerm('  Refresh~token?  ')).toBe('Refresh token');
  });
});
