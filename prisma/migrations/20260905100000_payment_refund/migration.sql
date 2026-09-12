-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'REFUNDED';

-- AlterTable
ALTER TABLE "Application" ADD COLUMN "paidAt" TIMESTAMP(3),
ADD COLUMN "refundedAt" TIMESTAMP(3);
