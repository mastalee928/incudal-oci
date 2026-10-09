ALTER TABLE "hosts"
  ADD COLUMN "machine_group" TEXT,
  ADD COLUMN "region_group" TEXT;
CREATE INDEX "hosts_machine_group_region_group_idx" ON "hosts"("machine_group", "region_group");

ALTER TABLE "host_onboarding_nodes"
  ADD COLUMN "machine_group" TEXT,
  ADD COLUMN "region_group" TEXT,
  ADD COLUMN "country_code" TEXT;
