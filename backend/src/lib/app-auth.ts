import type { Request, Response, NextFunction } from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';

const TOKEN_TTL = (process.env.APP_TOKEN_TTL || '7d') as SignOptions['expiresIn'];

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not configured');
  return secret;
}

export interface AppParentTokenPayload {
  sub: string;
  username: string;
  role: 'app_parent';
}

export function signAppParentToken(parent: { id: string; username: string }): string {
  const payload: AppParentTokenPayload = { sub: parent.id, username: parent.username, role: 'app_parent' };
  return jwt.sign(payload, getJwtSecret(), { expiresIn: TOKEN_TTL });
}

export function requireAppParent(req: Request, res: Response, next: NextFunction): void {
  const auth = req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const payload = jwt.verify(token, getJwtSecret()) as AppParentTokenPayload;
    if (payload.role !== 'app_parent') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    (req as Request & { appParent?: AppParentTokenPayload }).appParent = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}
