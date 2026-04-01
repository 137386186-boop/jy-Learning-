import path from 'path';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import oauthRoutes from './routes/oauth';
import replyRoutes from './routes/reply';
import contentsRoutes from './routes/contents';
import replyTemplatesRoutes from './routes/reply-templates';
import adminRoutes from './routes/admin';
import biliExperimentRouter from './routes/bili-experiment';
import { prisma } from './lib/prisma';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

const app = express();
const PORT = process.env.PORT ?? 3001;

app.set('trust proxy', 1);
app.disable('x-powered-by');

const corsOrigins = (process.env.CORS_ORIGIN ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions =
  corsOrigins.length === 0
    ? { origin: true, credentials: true }
    : {
        origin: (origin: string | undefined, callback: (err: Error | null, ok?: boolean) => void) => {
          if (!origin) return callback(null, true);
          if (corsOrigins.includes(origin)) return callback(null, true);
          return callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
      };

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

app.use('/api/oauth', oauthRoutes);
app.use('/api/reply', replyRoutes);
app.use('/api/contents', contentsRoutes);
app.use('/api/reply-templates', replyTemplatesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/bili-experiment', biliExperimentRouter);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

async function ensureAdminFromEnv() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  const forceReset = process.env.ADMIN_FORCE_RESET === 'true';

  if (!password) return;

  const existing = await prisma.admin.findUnique({ where: { username } });
  if (existing && !forceReset) return;

  const passwordHash = await bcrypt.hash(password, 10);
  if (existing) {
    await prisma.admin.update({ where: { username }, data: { passwordHash } });
    console.log(`Admin "${username}" password reset on startup.`);
  } else {
    await prisma.admin.create({ data: { username, passwordHash } });
    console.log(`Admin "${username}" created on startup.`);
  }
}

async function start() {
  try {
    await ensureAdminFromEnv();
    app.listen(PORT, () => {
      console.log(`Backend listening on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Backend startup failed:', error);
    process.exit(1);
  }
}

start();
