import path from 'path';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import appRoutes from './routes/app';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

const app = express();
const PORT = process.env.PORT ?? 3001;

app.set('trust proxy', 1);
app.disable('x-powered-by');

const corsOrigins = (process.env.APP_CORS_ORIGIN ?? process.env.CORS_ORIGIN ?? '')
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

app.use('/api/app', appRoutes);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'app-api' });
});

app.listen(PORT, () => {
  console.log(`App API listening on http://localhost:${PORT}`);
});
