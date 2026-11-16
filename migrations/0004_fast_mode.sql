-- fastest-mode clients: auto-healing subscriptions (clean-IP-first, self-replacing)
ALTER TABLE "Client" ADD COLUMN "fastMode" BOOLEAN NOT NULL DEFAULT false;
