import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/prisma', () => ({
  prisma: {
    platform: {
      findFirst: vi.fn(),
    },
    content: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import router from './contents';
import { prisma } from '../lib/prisma';

const mockedPrisma = prisma as unknown as {
  platform: { findFirst: ReturnType<typeof vi.fn> };
  content: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
};

describe('GET /api/contents', () => {
  const app = express();
  app.use('/', router);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.platform.findFirst.mockResolvedValue(null);
    mockedPrisma.content.findMany.mockResolvedValue([]);
    mockedPrisma.content.count.mockResolvedValue(0);
  });

  it('normalizes invalid filters and exposes appliedFilters', async () => {
    const res = await request(app).get('/').query({
      contentType: 'invalid',
      replied: 'maybe',
      publishedFrom: 'not-a-date',
      page: '0',
      pageSize: '9999',
      keyword: '  abc  ',
    });

    expect(res.status).toBe(200);
    expect(res.body.appliedFilters).toEqual({
      platformId: undefined,
      contentType: undefined,
      replied: undefined,
      publishedFrom: undefined,
      publishedTo: undefined,
      keyword: 'abc',
      page: 1,
      pageSize: 100,
    });

    expect(mockedPrisma.content.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 100,
        where: {
          OR: [
            { body: { contains: 'abc' } },
            { summary: { contains: 'abc' } },
            { keywordTags: { has: 'abc' } },
          ],
        },
      })
    );
  });

  it('drops disabled or unknown platform from appliedFilters', async () => {
    mockedPrisma.platform.findFirst.mockResolvedValueOnce(null);

    const res = await request(app).get('/').query({ platformId: 'bad_platform' });

    expect(res.status).toBe(200);
    expect(mockedPrisma.platform.findFirst).toHaveBeenCalledWith({
      where: { id: 'bad_platform', enabled: true },
      select: { id: true },
    });
    expect(res.body.appliedFilters.platformId).toBeUndefined();

    expect(mockedPrisma.content.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });

  it('keeps valid filters and pagination in appliedFilters', async () => {
    mockedPrisma.platform.findFirst.mockResolvedValueOnce({ id: 'p_1' });

    const res = await request(app).get('/').query({
      platformId: 'p_1',
      contentType: 'post',
      replied: 'false',
      publishedFrom: '2026-01-01T00:00:00.000Z',
      publishedTo: '2026-01-31T23:59:59.000Z',
      page: '2',
      pageSize: '20',
    });

    expect(res.status).toBe(200);
    expect(res.body.appliedFilters).toMatchObject({
      platformId: 'p_1',
      contentType: 'post',
      replied: 'false',
      page: 2,
      pageSize: 20,
    });
    expect(res.body.appliedFilters.publishedFrom).toBe('2026-01-01T00:00:00.000Z');
    expect(res.body.appliedFilters.publishedTo).toBe('2026-01-31T23:59:59.000Z');
  });
});
