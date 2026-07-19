-- Add explicit upload category for evidence files (replaces path-string matching)
ALTER TABLE "EvidenceFile" ADD COLUMN "uploadKey" TEXT NOT NULL DEFAULT 'general';

-- Backfill from storage path: evidence/{applicationId}/{uploadKey}/{filename}
UPDATE "EvidenceFile"
SET "uploadKey" = split_part("fileUrl", '/', 3)
WHERE "fileUrl" LIKE 'evidence/%/%/%'
  AND split_part("fileUrl", '/', 3) <> '';

CREATE INDEX "EvidenceFile_applicationId_uploadKey_idx"
ON "EvidenceFile"("applicationId", "uploadKey");
