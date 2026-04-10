import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { requireAppParent, signAppParentToken, type AppParentTokenPayload } from '../lib/app-auth';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

function getParent(req: Request): AppParentTokenPayload | null {
  return (req as Request & { appParent?: AppParentTokenPayload }).appParent || null;
}

async function ensureOwnedChild(parentId: string, childId: string) {
  return prisma.appChild.findFirst({ where: { id: childId, parentId } });
}

async function ensureOwnedTask(parentId: string, taskId: string) {
  return prisma.learningTask.findFirst({ where: { id: taskId, parentId } });
}

router.post('/auth/register', authLimiter, async (req: Request, res: Response) => {
  try {
    const { username, password, displayName } = req.body as {
      username?: string;
      password?: string;
      displayName?: string;
    };
    const u = username?.trim();
    const p = password?.trim();
    const d = displayName?.trim() || u;
    if (!u || !p) {
      res.status(400).json({ error: 'username and password required' });
      return;
    }
    if (p.length < 6) {
      res.status(400).json({ error: 'password too short' });
      return;
    }
    const existed = await prisma.appParent.findUnique({ where: { username: u } });
    if (existed) {
      res.status(409).json({ error: 'username already exists' });
      return;
    }
    const passwordHash = await bcrypt.hash(p, 10);
    const parent = await prisma.appParent.create({
      data: { username: u, passwordHash, displayName: d || u },
      select: { id: true, username: true, displayName: true },
    });
    const token = signAppParentToken({ id: parent.id, username: parent.username });
    res.json({ token, parent });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.post('/auth/login', authLimiter, async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body as { username?: string; password?: string };
    const u = username?.trim();
    const p = password?.trim();
    if (!u || !p) {
      res.status(400).json({ error: 'username and password required' });
      return;
    }
    const parent = await prisma.appParent.findUnique({ where: { username: u } });
    if (!parent) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const ok = await bcrypt.compare(p, parent.passwordHash);
    if (!ok) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const token = signAppParentToken({ id: parent.id, username: parent.username });
    res.json({ token, parent: { id: parent.id, username: parent.username, displayName: parent.displayName } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.get('/auth/me', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const parent = await prisma.appParent.findUnique({
    where: { id: payload.sub },
    select: { id: true, username: true, displayName: true, createdAt: true },
  });
  if (!parent) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.json(parent);
});

router.get('/children', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const list = await prisma.appChild.findMany({
    where: { parentId: payload.sub },
    orderBy: { createdAt: 'desc' },
  });
  res.json(list);
});

router.post('/children', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { name, avatarUrl, birthDate, gradeLevel } = req.body as {
      name?: string;
      avatarUrl?: string;
      birthDate?: string;
      gradeLevel?: string;
    };
    const n = name?.trim();
    if (!n) {
      res.status(400).json({ error: 'name required' });
      return;
    }
    const created = await prisma.appChild.create({
      data: {
        parentId: payload.sub,
        name: n,
        avatarUrl: avatarUrl?.trim() || null,
        gradeLevel: gradeLevel?.trim() || null,
        birthDate: birthDate ? new Date(birthDate) : null,
      },
    });
    res.json(created);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.get('/children/:id', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const child = await ensureOwnedChild(payload.sub, req.params.id);
  if (!child) {
    res.status(404).json({ error: 'Child not found' });
    return;
  }
  res.json(child);
});

router.patch('/children/:id', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const child = await ensureOwnedChild(payload.sub, req.params.id);
    if (!child) {
      res.status(404).json({ error: 'Child not found' });
      return;
    }
    const { name, avatarUrl, birthDate, gradeLevel } = req.body as {
      name?: string;
      avatarUrl?: string;
      birthDate?: string;
      gradeLevel?: string;
    };
    const updated = await prisma.appChild.update({
      where: { id: child.id },
      data: {
        name: name?.trim() || child.name,
        avatarUrl: avatarUrl === undefined ? child.avatarUrl : avatarUrl?.trim() || null,
        gradeLevel: gradeLevel === undefined ? child.gradeLevel : gradeLevel?.trim() || null,
        birthDate: birthDate === undefined ? child.birthDate : birthDate ? new Date(birthDate) : null,
      },
    });
    res.json(updated);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.delete('/children/:id', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const child = await ensureOwnedChild(payload.sub, req.params.id);
    if (!child) {
      res.status(404).json({ error: 'Child not found' });
      return;
    }
    await prisma.appChild.delete({ where: { id: child.id } });
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.get('/tasks', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const childId = (req.query.childId as string | undefined)?.trim();
  const status = (req.query.status as string | undefined)?.trim();
  const where: Record<string, unknown> = { parentId: payload.sub };
  if (childId) where.childId = childId;
  if (status === 'draft' || status === 'active' || status === 'archived') where.status = status;
  const list = await prisma.learningTask.findMany({
    where,
    include: { child: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(list);
});

router.post('/tasks', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { title, description, category, difficulty, childId, dueDate } = req.body as {
      title?: string;
      description?: string;
      category?: string;
      difficulty?: number;
      childId?: string;
      dueDate?: string;
    };
    const t = title?.trim();
    const c = category?.trim();
    if (!t || !c) {
      res.status(400).json({ error: 'title and category required' });
      return;
    }
    if (childId) {
      const child = await ensureOwnedChild(payload.sub, childId);
      if (!child) {
        res.status(403).json({ error: 'Forbidden child' });
        return;
      }
    }
    const created = await prisma.learningTask.create({
      data: {
        parentId: payload.sub,
        childId: childId || null,
        title: t,
        description: description?.trim() || null,
        category: c,
        difficulty: Math.max(1, Math.min(5, Number(difficulty) || 1)),
        dueDate: dueDate ? new Date(dueDate) : null,
      },
      include: { child: { select: { id: true, name: true } } },
    });
    if (created.childId) {
      await prisma.taskProgress.upsert({
        where: { taskId_childId: { taskId: created.id, childId: created.childId } },
        update: {},
        create: { taskId: created.id, childId: created.childId },
      });
    }
    res.json(created);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.get('/tasks/:id', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const task = await prisma.learningTask.findFirst({
    where: { id: req.params.id, parentId: payload.sub },
    include: {
      child: { select: { id: true, name: true } },
      progresses: true,
    },
  });
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json(task);
});

router.patch('/tasks/:id', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const task = await ensureOwnedTask(payload.sub, req.params.id);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    const { title, description, category, difficulty, childId, dueDate, status } = req.body as {
      title?: string;
      description?: string;
      category?: string;
      difficulty?: number;
      childId?: string | null;
      dueDate?: string | null;
      status?: 'draft' | 'active' | 'archived';
    };

    let nextChildId = task.childId;
    if (childId !== undefined) {
      if (childId) {
        const child = await ensureOwnedChild(payload.sub, childId);
        if (!child) {
          res.status(403).json({ error: 'Forbidden child' });
          return;
        }
        nextChildId = child.id;
      } else {
        nextChildId = null;
      }
    }

    const updated = await prisma.learningTask.update({
      where: { id: task.id },
      data: {
        title: title?.trim() || task.title,
        description: description === undefined ? task.description : description?.trim() || null,
        category: category?.trim() || task.category,
        difficulty: difficulty === undefined ? task.difficulty : Math.max(1, Math.min(5, Number(difficulty) || 1)),
        childId: nextChildId,
        dueDate: dueDate === undefined ? task.dueDate : dueDate ? new Date(dueDate) : null,
        status: status || task.status,
      },
      include: { child: { select: { id: true, name: true } } },
    });

    if (updated.childId) {
      await prisma.taskProgress.upsert({
        where: { taskId_childId: { taskId: updated.id, childId: updated.childId } },
        update: {},
        create: { taskId: updated.id, childId: updated.childId },
      });
    }

    res.json(updated);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.delete('/tasks/:id', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const task = await ensureOwnedTask(payload.sub, req.params.id);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    await prisma.learningTask.delete({ where: { id: task.id } });
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.get('/progress', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const childId = (req.query.childId as string | undefined)?.trim();
  if (!childId) {
    res.status(400).json({ error: 'childId required' });
    return;
  }
  const child = await ensureOwnedChild(payload.sub, childId);
  if (!child) {
    res.status(403).json({ error: 'Forbidden child' });
    return;
  }
  const progresses = await prisma.taskProgress.findMany({
    where: { childId },
    include: { task: { select: { id: true, title: true, category: true, dueDate: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  const total = progresses.length;
  const done = progresses.filter((p) => p.status === 'done').length;
  const submitted = progresses.filter((p) => p.status === 'submitted').length;
  res.json({ total, done, submitted, completionRate: total > 0 ? done / total : 0, list: progresses });
});

router.get('/reports/:childId', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const child = await ensureOwnedChild(payload.sub, req.params.childId);
  if (!child) {
    res.status(403).json({ error: 'Forbidden child' });
    return;
  }

  const progresses = await prisma.taskProgress.findMany({
    where: { childId: child.id },
    include: {
      task: {
        select: {
          id: true,
          title: true,
          category: true,
          difficulty: true,
          dueDate: true,
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const total = progresses.length;
  const done = progresses.filter((p) => p.status === 'done').length;
  const submitted = progresses.filter((p) => p.status === 'submitted').length;
  const inProgress = progresses.filter((p) => p.status === 'in_progress').length;
  const scored = progresses.filter((p) => p.score !== null && p.score !== undefined);
  const averageScore = scored.length > 0
    ? scored.reduce((acc, item) => acc + Number(item.score || 0), 0) / scored.length
    : null;

  const categoryMap = new Map<string, { total: number; done: number }>();
  for (const item of progresses) {
    const category = item.task.category;
    const current = categoryMap.get(category) || { total: 0, done: 0 };
    current.total += 1;
    if (item.status === 'done') current.done += 1;
    categoryMap.set(category, current);
  }

  const categoryStats = Array.from(categoryMap.entries()).map(([category, stat]) => ({
    category,
    total: stat.total,
    done: stat.done,
    completionRate: stat.total > 0 ? stat.done / stat.total : 0,
  }));

  res.json({
    child: { id: child.id, name: child.name, gradeLevel: child.gradeLevel },
    summary: {
      total,
      done,
      submitted,
      inProgress,
      completionRate: total > 0 ? done / total : 0,
      averageScore,
    },
    categoryStats,
    recent: progresses.slice(0, 20),
  });
});

router.get('/child/:childId/today', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const child = await ensureOwnedChild(payload.sub, req.params.childId);
  if (!child) {
    res.status(403).json({ error: 'Forbidden child' });
    return;
  }
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const list = await prisma.learningTask.findMany({
    where: {
      parentId: payload.sub,
      childId: child.id,
      status: 'active',
      OR: [{ dueDate: null }, { dueDate: { gte: start, lte: end } }],
    },
    include: {
      progresses: { where: { childId: child.id }, take: 1 },
    },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
  });
  res.json({ child: { id: child.id, name: child.name }, list });
});

router.post('/tasks/:taskId/start', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { childId } = req.body as { childId?: string };
  if (!childId) {
    res.status(400).json({ error: 'childId required' });
    return;
  }
  const child = await ensureOwnedChild(payload.sub, childId);
  if (!child) {
    res.status(403).json({ error: 'Forbidden child' });
    return;
  }
  const task = await ensureOwnedTask(payload.sub, req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const progress = await prisma.taskProgress.upsert({
    where: { taskId_childId: { taskId: task.id, childId: child.id } },
    update: { status: 'in_progress' },
    create: { taskId: task.id, childId: child.id, status: 'in_progress' },
  });
  res.json(progress);
});

router.post('/tasks/:taskId/submit', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { childId, answerData, score } = req.body as { childId?: string; answerData?: unknown; score?: number };
  if (!childId) {
    res.status(400).json({ error: 'childId required' });
    return;
  }
  const child = await ensureOwnedChild(payload.sub, childId);
  if (!child) {
    res.status(403).json({ error: 'Forbidden child' });
    return;
  }
  const task = await ensureOwnedTask(payload.sub, req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const progress = await prisma.taskProgress.upsert({
    where: { taskId_childId: { taskId: task.id, childId: child.id } },
    update: {
      status: 'submitted',
      answerData: answerData === undefined ? undefined : (answerData as object),
      score: score === undefined ? null : Number(score),
      submittedAt: new Date(),
    },
    create: {
      taskId: task.id,
      childId: child.id,
      status: 'submitted',
      answerData: (answerData as object) || undefined,
      score: score === undefined ? null : Number(score),
      submittedAt: new Date(),
    },
  });
  res.json(progress);
});

router.post('/tasks/:taskId/complete', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { childId } = req.body as { childId?: string };
  if (!childId) {
    res.status(400).json({ error: 'childId required' });
    return;
  }
  const child = await ensureOwnedChild(payload.sub, childId);
  if (!child) {
    res.status(403).json({ error: 'Forbidden child' });
    return;
  }
  const task = await ensureOwnedTask(payload.sub, req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const progress = await prisma.taskProgress.upsert({
    where: { taskId_childId: { taskId: task.id, childId: child.id } },
    update: { status: 'done', completedAt: new Date() },
    create: { taskId: task.id, childId: child.id, status: 'done', completedAt: new Date() },
  });
  res.json(progress);
});

export default router;
