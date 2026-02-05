-- AlterTable
ALTER TABLE "PlatformAuth" ADD COLUMN IF NOT EXISTS "access_token" TEXT;
ALTER TABLE "PlatformAuth" ADD COLUMN IF NOT EXISTS "refresh_token" TEXT;
ALTER TABLE "PlatformAuth" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3);
