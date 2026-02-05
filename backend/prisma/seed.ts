import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const prisma = new PrismaClient();

function md5like(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h = (h << 5) - h + c;
    h = h & h;
  }
  return Math.abs(h).toString(36) + s.length;
}

async function main() {
  const platforms = [
    { name: '知乎', slug: 'zhihu' },
    { name: '抖音', slug: 'douyin' },
    { name: '小红书', slug: 'xiaohongshu' },
    { name: 'B站', slug: 'bilibili' },
    { name: '快手', slug: 'kuaishou' },
  ];

  for (const p of platforms) {
    await prisma.platform.upsert({
      where: { slug: p.slug },
      create: p,
      update: { name: p.name },
    });
  }
  console.log('Platforms seeded.');

  const zhihu = await prisma.platform.findUnique({ where: { slug: 'zhihu' } });
  if (zhihu) {
    const demos = [
      {
        body: '请问学术论文投稿后一般多久会有初审结果？',
        summary: '请问学术论文投稿后一般多久会有初审结果？',
        contentType: 'post' as const,
        keywordTags: ['学术', '投稿'],
      },
      {
        body: '不同期刊差异很大，一般 1–4 周内会有初审，建议看该刊的投稿须知或近期文章周期。',
        summary: '不同期刊差异很大，一般 1–4 周内会有初审…',
        contentType: 'comment' as const,
        keywordTags: ['学术', '投稿'],
      },
      {
        body: '大家有没有好用的文献管理工具推荐？EndNote 和 Zotero 哪个更适合写学位论文？',
        summary: '大家有没有好用的文献管理工具推荐？',
        contentType: 'post' as const,
        keywordTags: ['文献管理', 'Zotero'],
      },
    ];
    const baseDate = new Date('2025-01-15T12:00:00Z');
    for (let i = 0; i < demos.length; i++) {
      const d = demos[i];
      const bodyMd5 = md5like(d.body + String(i));
      const publishedAt = new Date(baseDate.getTime() + i * 3600000);
      await prisma.content.upsert({
        where: {
          platformId_publishedAt_bodyMd5: {
            platformId: zhihu.id,
            publishedAt,
            bodyMd5,
          },
        },
        create: {
          platformId: zhihu.id,
          contentType: d.contentType,
          authorName: i === 0 ? '用户A' : i === 1 ? '用户B' : '用户C',
          body: d.body,
          bodyMd5,
          publishedAt,
          sourceUrl: `https://www.zhihu.com/question/demo-${i}`,
          keywordTags: d.keywordTags,
          summary: d.summary,
          likeCount: i === 1 ? 10 : 2,
          commentCount: i === 0 ? 3 : 0,
        },
        update: {},
      });
    }
    console.log('Demo contents seeded.');
  }

  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const passwordHash = await bcrypt.hash(adminPassword, 10);
  await prisma.admin.upsert({
    where: { username: 'admin' },
    create: { username: 'admin', passwordHash },
    update: { passwordHash },
  });
  console.log('Admin seeded (username: admin).');

  const existing = await prisma.replyTemplate.findFirst();
  if (!existing) {
    await prisma.replyTemplate.create({
      data: {
        title: '感谢关注',
        content: '感谢您的关注与讨论，我们会继续分享相关学术信息。',
      },
    });
    console.log('Reply template seeded.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
