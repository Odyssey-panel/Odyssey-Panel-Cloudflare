-- Odyssey 0003 — Zeus-style first-connection expiry anchoring
-- Client: "start on first connection" flag + plan days granted at creation

ALTER TABLE "Client" ADD COLUMN "startOnFirstConnection" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "Client" ADD COLUMN "planDays" INTEGER NOT NULL DEFAULT 0;
