-- CreateEnum
CREATE TYPE "LearningTaskStatus" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "TaskProgressStatus" AS ENUM ('not_started', 'in_progress', 'submitted', 'done');

-- CreateEnum
CREATE TYPE "ArtifactType" AS ENUM ('exercise', 'hint', 'summary', 'report', 'image');

-- CreateTable
CREATE TABLE "AppParent" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppParent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppChild" (
    "id" TEXT NOT NULL,
    "parent_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "birth_date" TIMESTAMP(3),
    "grade_level" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppChild_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningTask" (
    "id" TEXT NOT NULL,
    "parent_id" TEXT NOT NULL,
    "child_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "difficulty" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "status" "LearningTaskStatus" NOT NULL DEFAULT 'active',
    "due_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearningTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskProgress" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "child_id" TEXT NOT NULL,
    "status" "TaskProgressStatus" NOT NULL DEFAULT 'not_started',
    "score" INTEGER,
    "answer_data" JSONB,
    "submitted_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppArtifact" (
    "id" TEXT NOT NULL,
    "parent_id" TEXT NOT NULL,
    "child_id" TEXT,
    "task_id" TEXT,
    "type" "ArtifactType" NOT NULL,
    "content" JSONB NOT NULL,
    "model" TEXT,
    "prompt_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppParent_username_key" ON "AppParent"("username");

-- CreateIndex
CREATE INDEX "AppChild_parent_id_idx" ON "AppChild"("parent_id");

-- CreateIndex
CREATE INDEX "LearningTask_parent_id_idx" ON "LearningTask"("parent_id");

-- CreateIndex
CREATE INDEX "LearningTask_child_id_idx" ON "LearningTask"("child_id");

-- CreateIndex
CREATE INDEX "LearningTask_status_idx" ON "LearningTask"("status");

-- CreateIndex
CREATE INDEX "LearningTask_due_date_idx" ON "LearningTask"("due_date");

-- CreateIndex
CREATE INDEX "LearningTask_created_at_idx" ON "LearningTask"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "TaskProgress_task_id_child_id_key" ON "TaskProgress"("task_id", "child_id");

-- CreateIndex
CREATE INDEX "TaskProgress_child_id_idx" ON "TaskProgress"("child_id");

-- CreateIndex
CREATE INDEX "TaskProgress_status_idx" ON "TaskProgress"("status");

-- CreateIndex
CREATE INDEX "TaskProgress_created_at_idx" ON "TaskProgress"("created_at");

-- CreateIndex
CREATE INDEX "AppArtifact_parent_id_idx" ON "AppArtifact"("parent_id");

-- CreateIndex
CREATE INDEX "AppArtifact_child_id_idx" ON "AppArtifact"("child_id");

-- CreateIndex
CREATE INDEX "AppArtifact_task_id_idx" ON "AppArtifact"("task_id");

-- CreateIndex
CREATE INDEX "AppArtifact_type_idx" ON "AppArtifact"("type");

-- CreateIndex
CREATE INDEX "AppArtifact_created_at_idx" ON "AppArtifact"("created_at");

-- AddForeignKey
ALTER TABLE "AppChild" ADD CONSTRAINT "AppChild_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "AppParent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningTask" ADD CONSTRAINT "LearningTask_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "AppParent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningTask" ADD CONSTRAINT "LearningTask_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "AppChild"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskProgress" ADD CONSTRAINT "TaskProgress_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "LearningTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskProgress" ADD CONSTRAINT "TaskProgress_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "AppChild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppArtifact" ADD CONSTRAINT "AppArtifact_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "AppParent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppArtifact" ADD CONSTRAINT "AppArtifact_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "AppChild"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppArtifact" ADD CONSTRAINT "AppArtifact_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "LearningTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
