import { API_BASE } from './base';

const APP_TOKEN_KEY = 'app_parent_token';

export function getAppToken(): string | null {
  return localStorage.getItem(APP_TOKEN_KEY);
}

export function setAppToken(token: string): void {
  localStorage.setItem(APP_TOKEN_KEY, token);
}

export function clearAppToken(): void {
  localStorage.removeItem(APP_TOKEN_KEY);
}

export async function appFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getAppToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) clearAppToken();
  return response;
}

export const APP_API_BASE = `${API_BASE}/app`;
