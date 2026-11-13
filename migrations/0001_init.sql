-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "limitBytes" BIGINT NOT NULL DEFAULT 0,
    "usedBytes" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'active',
    "subToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Proxy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "remark" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "secret" TEXT NOT NULL,
    "sni" TEXT,
    "host" TEXT,
    "path" TEXT,
    "transport" TEXT NOT NULL DEFAULT 'ws',
    "tls" BOOLEAN NOT NULL DEFAULT true,
    "flow" TEXT,
    "fragment" TEXT,
    "serverConfig" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Proxy_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Node" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'vless',
    "tls" BOOLEAN NOT NULL DEFAULT true,
    "sni" TEXT,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "latencyMs" INTEGER,
    "certExpiresAt" DATETIME,
    "lastCheckedAt" DATETIME,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Worker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "latencyMs" INTEGER,
    "httpStatus" INTEGER,
    "lastCheckedAt" DATETIME,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_name_key" ON "Client"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Client_subToken_key" ON "Client"("subToken");

