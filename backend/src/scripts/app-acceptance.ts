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

async function requestRaw(pathname: string, init: RequestInit = {}) {
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

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollMaterialStatus(
  materialId: string,
  token: string,
  type: 'recognize' | 'generate',
  maxAttempts = 40,
  intervalMs = 1200
) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const material = (await requestJson(`/api/app/library/materials/${materialId}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })) as {
      taskId?: string | null;
      content?: {
        status?: string;
        recognitionStatus?: string;
        mediaStatus?: string;
      };
    };

    const content = material.content || {};
    const status = String(content.status || '');
    const recognitionStatus = String(content.recognitionStatus || '');

    if (status === 'failed') {
      throw new Error(`material ${materialId} ${type} failed`);
    }

    if (type === 'recognize') {
      if (recognitionStatus === 'completed' || recognitionStatus === 'fallback') return material;
    } else if (status === 'task_generated' || !!material.taskId) {
      return material;
    }

    await wait(intervalMs);
  }

  throw new Error(`material ${materialId} ${type} polling timeout`);
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
  })) as { ok?: boolean; message?: string };

  assert(register.ok === true, 'register failed');

  const login = (await requestJson('/api/app/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })) as { token?: string; parent?: { id: string; username: string } };

  assert(!!login.token, 'login did not return token');
  const token = login.token as string;

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

  const formData = new FormData();
  const uploadText = `acceptance text ${now}`;
  formData.append('file', new Blob([uploadText], { type: 'text/plain' }), `acceptance-${now}.txt`);
  formData.append('childId', String(child.id));

  const uploaded = (await requestRaw('/api/app/library/materials', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  })) as { id?: string; content?: { status?: string } };
  assert(!!uploaded.id, 'material upload failed');

  const recognizedKickoff = (await requestJson(`/api/app/library/materials/${uploaded.id}/recognize`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })) as { id?: string; content?: { recognitionStatus?: string } };
  assert(recognizedKickoff.id === uploaded.id, 'recognize kickoff failed');

  const recognizedDone = await pollMaterialStatus(String(uploaded.id), token, 'recognize');
  const recognizedStatus = String(recognizedDone.content?.recognitionStatus || '');
  assert(recognizedStatus === 'completed' || recognizedStatus === 'fallback', 'recognize result status invalid');

  const generatedKickoff = (await requestJson(`/api/app/library/materials/${uploaded.id}/generate-task`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ childId: child.id }),
  })) as { id?: string };
  assert(generatedKickoff.id === uploaded.id, 'generate-task kickoff failed');

  const generatedDone = await pollMaterialStatus(String(uploaded.id), token, 'generate');
  assert(!!generatedDone.taskId, 'generated task id missing on material');

  const generatedTaskInList = (await requestJson('/api/app/tasks', {
    headers: { Authorization: `Bearer ${token}` },
  })) as Array<{ id: string }>;
  assert(generatedTaskInList.some((item) => item.id === generatedDone.taskId), 'generated task not found in task list');

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl: BASE_URL,
        parentId: login.parent?.id,
        childId: child.id,
        taskId: task.id,
        materialId: uploaded.id,
        generatedTaskId: generatedDone.taskId,
        checks: [
          'health',
          'register/login',
          'create child',
          'create task',
          'today list',
          'start/submit/complete',
          'progress',
          'report',
          'library upload',
          'library recognize (async + poll)',
          'library generate-task (async + poll)',
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
