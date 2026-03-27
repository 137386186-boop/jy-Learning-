import { describe, expect, it } from 'vitest';
import { normalizeContentListQuery, toContentListSearchParams } from './ContentList';

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

describe('toContentListSearchParams', () => {
  it('keeps valid deep link filters', () => {
    const params = toContentListSearchParams({
      platformId: 'plat_123',
      contentType: 'post',
      page: 1,
    });

    expect(params.toString()).toBe('platformId=plat_123&contentType=post');
  });

  it('normalizes first page by removing page=1', () => {
    const params = toContentListSearchParams({
      keyword: 'abc',
      page: 1,
    });

    expect(params.toString()).toBe('keyword=abc');
  });

  it('keeps page when greater than one', () => {
    const params = toContentListSearchParams({
      contentType: 'comment',
      page: 4,
    });

    expect(params.toString()).toBe('contentType=comment&page=4');
  });
});
