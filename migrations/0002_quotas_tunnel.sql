-- Odyssey 0002 — quota / anti-censorship additions
-- Client: request quota, device cap, first-connection expiry, reset cycles
-- Proxy:  fingerprint, ECH, plugin fields

ALTER TABLE "Client" ADD COLUMN "startedAt" DATETIME;
ALTER TABLE "Client" ADD COLUMN "usedRequests" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Client" ADD COLUMN "requestLimit" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Client" ADD COLUMN "ipLimit" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Client" ADD COLUMN "resetBytesDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Client" ADD COLUMN "resetRequestsDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Client" ADD COLUMN "lastBytesResetAt" DATETIME;
ALTER TABLE "Client" ADD COLUMN "lastRequestsResetAt" DATETIME;
ALTER TABLE "Client" ADD COLUMN "directEnabled" BOOLEAN NOT NULL DEFAULT 1;
ALTER TABLE "Client" ADD COLUMN "fingerprint" TEXT NOT NULL DEFAULT 'chrome';
ALTER TABLE "Client" ADD COLUMN "isp" TEXT;

ALTER TABLE "Proxy" ADD COLUMN "fp" TEXT;
ALTER TABLE "Proxy" ADD COLUMN "ech" TEXT;
ALTER TABLE "Proxy" ADD COLUMN "plugin" TEXT;
