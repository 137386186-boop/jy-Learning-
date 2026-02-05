import path from 'path';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import oauthRoutes from './routes/oauth';
import replyRoutes from './routes/reply';
import contentsRoutes from './routes/contents';
import replyTemplatesRoutes from './routes/reply-templates';
import adminRoutes from './routes/admin';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

const app = express();
const PORT = process.env.PORT ?? 3001;

app.set('trust proxy', 1);

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

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
