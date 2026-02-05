import type { Request, Response, NextFunction } from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';

const TOKEN_TTL = (process.env.ADMIN_TOKEN_TTL || '7d') as SignOptions['expiresIn'];

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET not configured');
  }
  return secret;
}

export interface AdminTokenPayload {
  sub: string;
  username: string;
  role: 'admin';
}

export function signAdminToken(admin: { id: string; username: string }): string {
  const payload: AdminTokenPayload = { sub: admin.id, username: admin.username, role: 'admin' };
  return jwt.sign(payload, getJwtSecret(), { expiresIn: TOKEN_TTL });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const auth = req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const payload = jwt.verify(token, getJwtSecret()) as AdminTokenPayload;
    if (payload.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    (req as Request & { admin?: AdminTokenPayload }).admin = payload;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}
