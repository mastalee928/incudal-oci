CREATE TABLE "host_onboarding_batches" (
  "id" TEXT PRIMARY KEY,
  "created_by_id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "account_label" TEXT NOT NULL,
  "defaults" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "host_onboarding_batches_created_at_idx" ON "host_onboarding_batches" ("created_at" DESC);

CREATE TABLE "host_onboarding_nodes" (
  "id" TEXT PRIMARY KEY,
  "batch_id" TEXT NOT NULL REFERENCES "host_onboarding_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "host_id" INTEGER REFERENCES "hosts"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "public_ip" TEXT NOT NULL,
  "ssh_port" INTEGER NOT NULL DEFAULT 22,
  "ssh_fingerprint" TEXT,
  "credentials_encrypted" TEXT,
  "credentials_expire_at" TIMESTAMP(3) NOT NULL,
  "management_ip" TEXT,
  "node_public_key" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "step" TEXT NOT NULL DEFAULT 'queued',
  "error_code" TEXT,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "lease_token" TEXT,
  "lease_until" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "host_onboarding_nodes_host_id_key" ON "host_onboarding_nodes"("host_id");
CREATE UNIQUE INDEX "host_onboarding_nodes_public_ip_key" ON "host_onboarding_nodes"("public_ip");
CREATE UNIQUE INDEX "host_onboarding_nodes_batch_id_name_key" ON "host_onboarding_nodes"("batch_id", "name");
CREATE INDEX "host_onboarding_nodes_status_lease_until_idx" ON "host_onboarding_nodes"("status", "lease_until");
