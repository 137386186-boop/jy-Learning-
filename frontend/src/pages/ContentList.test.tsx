import { describe, expect, it } from 'vitest';
import { normalizeContentListQuery } from './ContentList';

describe('normalizeContentListQuery', () => {
  it('drops invalid filter values', () => {
    const params = new URLSearchParams({
      contentType: 'invalid',
      replied: 'unknown',
      page: '0',
      publishedFrom: 'bad',
      publishedTo: 'bad2',
      keyword: '  hello  ',
    });

    expect(normalizeContentListQuery(params)).toEqual({
      keyword: 'hello',
      page: 1,
    });
  });

  it('keeps valid values with canonical dates', () => {
    const params = new URLSearchParams({
      platformId: 'p_1',
      contentType: 'post',
      replied: 'false',
      page: '3',
      publishedFrom: '2026-01-01T00:00:00.000Z',
      publishedTo: '2026-01-31T23:59:59.000Z',
    });

    expect(normalizeContentListQuery(params)).toEqual({
      platformId: 'p_1',
      contentType: 'post',
      replied: 'false',
      page: 3,
      publishedFrom: '2026-01-01T00:00:00.000Z',
      publishedTo: '2026-01-31T23:59:59.000Z',
    });
  });
});
