# Deployment Guide (Draft)

This guide targets:
- Frontend: Vercel
- Backend: Render
- Database: Supabase (Postgres)

## 1) Database choice
This project can run against an existing Supabase database. If you **do not** want to change schema data,
skip migrations/seed locally and only set environment variables in the hosting platform.
If you do want a separate dev database, create a new Supabase project and use its connection strings.

## 2) Local setup (safe mode)
1. Backend:
   - `cd backend`
   - `npm install`
   - `npx prisma generate`
   - `npm run dev`
2. Frontend:
   - `cd frontend`
   - `npm install`
   - `npm run dev`

## 3) Render (backend)
1. Create a new Web Service from this repo.
2. Root directory: `backend`
3. Build command:
   - `npm install && npx prisma generate && npm run build`
4. Start command:
   - `npm run start`
5. Environment variables:
   - `DATABASE_URL`
   - `DIRECT_URL`
   - `JWT_SECRET`
   - `ADMIN_TOKEN_TTL`
   - `ADMIN_PASSWORD` (only needed for seeding or resets)
   - `CORS_ORIGIN` (e.g. `https://jylearning.com,https://www.jylearning.com`)
   - `FRONTEND_ORIGIN` (e.g. `https://jylearning.com`)
   - `ZHIHU_CLIENT_ID`
   - `ZHIHU_CLIENT_SECRET`
6. Deploy and note the backend public URL.
7. Create admin (one-time):
   - Open the Render Shell
   - Run: `npm run admin:create:prod`
   - If you want to reset admin password later, set `ADMIN_FORCE_RESET=true` and run again.

## 4) Vercel (frontend)
1. Import the repo as a Vercel project.
2. Root directory: `frontend`
3. Add environment variable:
   - `VITE_API_BASE` = backend public URL + `/api` (e.g. `https://jylearning.onrender.com/api`)
4. Build & deploy.

## 5) DNS & domain
1. Point `jylearning.com` to Vercel (frontend).
2. Optionally set a subdomain `api.jylearning.com` to Render (backend), then set:
   - `VITE_API_BASE=https://api.jylearning.com/api` (if using a custom API subdomain)
   - `CORS_ORIGIN=https://jylearning.com,https://www.jylearning.com`
   - `FRONTEND_ORIGIN=https://jylearning.com`

## 6) OAuth callback notes
Zhihu OAuth callback uses backend `/api/oauth/zhihu/callback`, then redirects to:
`{FRONTEND_ORIGIN}/admin/oauth?zhihu=ok`.

Make sure the OAuth app config allows the exact callback URL from the backend domain.
