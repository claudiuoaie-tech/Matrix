-- Phase 4: Client management & worker operations.
-- Both changes are additive and nullable, so they are safe on a populated table.

-- Worker soft-delete marker. Existing rows stay NULL (= not deleted).
ALTER TABLE "workers" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "workers_deletedAt_idx" ON "workers"("deletedAt");

-- Client main contact phone number.
ALTER TABLE "clients" ADD COLUMN "phone" TEXT;
