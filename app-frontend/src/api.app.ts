import { APP_API_BASE } from './api.base';

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

export interface AppUploadResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export function appUpload(
  url: string,
  formData: FormData,
  onProgress?: (percent: number) => void
): Promise<AppUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    const token = getAppToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        const pct = Math.min(99, Math.round((event.loaded / event.total) * 100));
        onProgress(pct);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 401) clearAppToken();
      let parsed: unknown = {};
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        parsed = { message: xhr.responseText?.slice(0, 200) || '响应解析失败' };
      }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data: parsed });
    };

    xhr.onerror = () => reject(new Error('network_error'));
    xhr.onabort = () => reject(new Error('aborted'));

    xhr.send(formData);
  });
}

export { APP_API_BASE };
