-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('post', 'comment');

-- AlterTable
ALTER TABLE "Content" ADD COLUMN     "content_type" "ContentType" NOT NULL DEFAULT 'post';
