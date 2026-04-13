import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

const BASE_URL = (process.env.APP_ACCEPTANCE_BASE_URL || 'https://jy-learning-app-api.onrender.com').replace(/\/$/, '');

async function requestJson(pathname: string, init: RequestInit = {}) {
  const url = `${BASE_URL}${pathname}`;
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${pathname} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function main() {
  const now = Date.now();
  const username = `accept_parent_${now}`;
  const password = 'pass123456';
  const displayName = 'Acceptance Parent';

  const health = (await requestJson('/api/health')) as { ok?: boolean };
  assert(health.ok === true, 'api health check failed');

  const register = (await requestJson('/api/app/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, displayName }),
  })) as { token?: string; parent?: { id: string; username: string } };

  assert(!!register.token, 'register did not return token');
  const token = register.token as string;

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const me = (await requestJson('/api/app/auth/me', { headers: authHeaders })) as { id?: string; username?: string };
  assert(me.username === username, 'auth/me username mismatch');

  const child = (await requestJson('/api/app/children', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: `验收孩子-${now}`, gradeLevel: 'primary_prep' }),
  })) as { id?: string; name?: string };
  assert(!!child.id, 'create child failed');

  const task = (await requestJson('/api/app/tasks', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      title: `验收任务-${now}`,
      category: 'math',
      difficulty: 3,
      childId: child.id,
    }),
  })) as { id?: string; childId?: string | null };
  assert(!!task.id, 'create task failed');

  const today = (await requestJson(`/api/app/child/${child.id}/today`, {
    headers: { Authorization: `Bearer ${token}` },
  })) as { list?: Array<{ id: string }> };
  assert(Array.isArray(today.list), 'today list invalid');
  assert(today.list!.some((item) => item.id === task.id), 'today list missing created task');

  const started = (await requestJson(`/api/app/tasks/${task.id}/start`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ childId: child.id }),
  })) as { status?: string };
  assert(started.status === 'in_progress', 'task start status invalid');

  const submitted = (await requestJson(`/api/app/tasks/${task.id}/submit`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ childId: child.id, answerData: { note: 'acceptance' }, score: 95 }),
  })) as { status?: string; score?: number };
  assert(submitted.status === 'submitted', 'task submit status invalid');
  assert(Number(submitted.score) === 95, 'task submit score invalid');

  const completed = (await requestJson(`/api/app/tasks/${task.id}/complete`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ childId: child.id }),
  })) as { status?: string };
  assert(completed.status === 'done', 'task complete status invalid');

  const progress = (await requestJson(`/api/app/progress?childId=${child.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  })) as { total?: number; done?: number };
  assert((progress.total || 0) >= 1, 'progress total invalid');
  assert((progress.done || 0) >= 1, 'progress done invalid');

  const report = (await requestJson(`/api/app/reports/${child.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  })) as { summary?: { total?: number; done?: number } };
  assert((report.summary?.total || 0) >= 1, 'report total invalid');
  assert((report.summary?.done || 0) >= 1, 'report done invalid');

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl: BASE_URL,
        parentId: register.parent?.id,
        childId: child.id,
        taskId: task.id,
        checks: [
          'health',
          'register/login',
          'create child',
          'create task',
          'today list',
          'start/submit/complete',
          'progress',
          'report',
        ],
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
