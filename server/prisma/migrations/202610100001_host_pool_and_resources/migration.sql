-- Additive migration. Existing hosts, instances and onboarding recovery IDs remain intact.
CREATE TABLE "host_machine_groups" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "host_region_groups" (
  "id" SERIAL PRIMARY KEY,
  "machine_group_id" INTEGER NOT NULL REFERENCES "host_machine_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "country_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "host_region_groups_machine_group_id_name_key" ON "host_region_groups"("machine_group_id", "name");

ALTER TABLE "hosts"
  ADD COLUMN "machine_group_id" INTEGER REFERENCES "host_machine_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD COLUMN "region_group_id" INTEGER REFERENCES "host_region_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD COLUMN "resource_preset" TEXT,
  ADD COLUMN "customer_disk_gib" INTEGER,
  ADD COLUMN "resource_snapshot" JSONB,
  ADD COLUMN "single_tenant" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "hosts_machine_group_id_region_group_id_idx" ON "hosts"("machine_group_id", "region_group_id");

ALTER TABLE "host_onboarding_nodes"
  ADD COLUMN "machine_group_id" INTEGER REFERENCES "host_machine_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD COLUMN "region_group_id" INTEGER REFERENCES "host_region_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD COLUMN "resource_preset" TEXT,
  ADD COLUMN "customer_disk_gib" INTEGER,
  ADD COLUMN "resolved_resources" JSONB,
  ADD COLUMN "deleted_at" TIMESTAMP(3);
CREATE INDEX "host_onboarding_nodes_deleted_at_created_at_idx" ON "host_onboarding_nodes"("deleted_at", "created_at");

INSERT INTO "host_machine_groups" ("name")
SELECT DISTINCT name FROM (
  SELECT 'E2' AS name UNION ALL SELECT 'ARM'
  UNION ALL SELECT NULLIF(BTRIM(machine_group), '') FROM hosts
  UNION ALL SELECT NULLIF(BTRIM(COALESCE(n.machine_group, b.defaults->>'machineGroup')), '')
    FROM host_onboarding_nodes n JOIN host_onboarding_batches b ON b.id = n.batch_id
) names WHERE name IS NOT NULL ON CONFLICT DO NOTHING;

UPDATE hosts h SET machine_group_id = g.id, machine_group = g.name
FROM host_machine_groups g WHERE NULLIF(BTRIM(h.machine_group), '') = g.name;
UPDATE host_onboarding_nodes n SET machine_group_id = g.id, machine_group = g.name
FROM host_onboarding_batches b, host_machine_groups g
WHERE b.id = n.batch_id AND NULLIF(BTRIM(COALESCE(n.machine_group, b.defaults->>'machineGroup')), '') = g.name;

INSERT INTO host_region_groups (machine_group_id, name)
SELECT DISTINCT machine_group_id, name FROM (
  SELECT machine_group_id, NULLIF(BTRIM(region_group), '') AS name FROM hosts
  UNION ALL
  SELECT n.machine_group_id, NULLIF(BTRIM(COALESCE(n.region_group, b.defaults->>'regionGroup')), '')
    FROM host_onboarding_nodes n JOIN host_onboarding_batches b ON b.id = n.batch_id
) names WHERE machine_group_id IS NOT NULL AND name IS NOT NULL ON CONFLICT DO NOTHING;

-- Initial suggestions are real empty groups, so they also exist before hosts are imported.
INSERT INTO host_region_groups (machine_group_id, name, country_code)
SELECT g.id, r.name, r.country_code FROM host_machine_groups g
CROSS JOIN (VALUES ('凤凰城', 'us'), ('圣何塞', 'us'), ('伦敦', 'gb'), ('首尔', 'kr')) AS r(name, country_code)
WHERE g.name IN ('E2', 'ARM') ON CONFLICT DO NOTHING;

UPDATE hosts h SET region_group_id = g.id, region_group = g.name
FROM host_region_groups g WHERE h.machine_group_id = g.machine_group_id AND NULLIF(BTRIM(h.region_group), '') = g.name;
UPDATE host_onboarding_nodes n SET region_group_id = g.id, region_group = g.name
FROM host_onboarding_batches b, host_region_groups g
WHERE b.id = n.batch_id AND n.machine_group_id = g.machine_group_id
  AND NULLIF(BTRIM(COALESCE(n.region_group, b.defaults->>'regionGroup')), '') = g.name;

-- Onboarded hosts are dedicated inventory. Do not guess customer disk quotas for old hosts.
UPDATE hosts SET single_tenant = true WHERE id IN (SELECT host_id FROM host_onboarding_nodes WHERE host_id IS NOT NULL);

-- Serialize new assignments on the host row, including imports and host moves.
-- Existing multi-instance legacy hosts can still stop/delete their old instances.
CREATE INDEX "instance_tasks_target_host_id_status_idx" ON "instance_tasks"("target_host_id", "status");
CREATE FUNCTION "check_single_tenant_host"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  dedicated BOOLEAN;
  cap_cpu INTEGER;
  cap_memory INTEGER;
  cap_disk INTEGER;
  new_assignment BOOLEAN := true;
BEGIN
  IF NEW.status = 'deleted' AND NOT NEW.provisioning_cleanup_pending AND NOT NEW.deletion_billing_pending THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.host_id = NEW.host_id AND (OLD.status <> 'deleted' OR OLD.provisioning_cleanup_pending OR OLD.deletion_billing_pending) THEN
      new_assignment := false;
      IF NEW.cpu <= OLD.cpu AND NEW.memory <= OLD.memory AND NEW.disk <= OLD.disk THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;
  SELECT single_tenant, cpu_allowance_max, memory_max, customer_disk_gib
    INTO dedicated, cap_cpu, cap_memory, cap_disk FROM hosts WHERE id = NEW.host_id FOR UPDATE;
  IF NOT dedicated THEN RETURN NEW; END IF;
  IF new_assignment AND EXISTS (SELECT 1 FROM instances WHERE host_id = NEW.host_id AND id <> NEW.id
    AND (status <> 'deleted' OR provisioning_cleanup_pending OR deletion_billing_pending)) THEN
    RAISE EXCEPTION 'HOST_SINGLE_TENANT_OCCUPIED' USING ERRCODE = '23514', CONSTRAINT = 'hosts_single_tenant_occupied';
  END IF;
  IF new_assignment AND EXISTS (SELECT 1 FROM instance_tasks WHERE target_host_id = NEW.host_id AND instance_id <> NEW.id
    AND task_type = 'change_host' AND status IN ('PENDING', 'PROCESSING')) THEN
    RAISE EXCEPTION 'HOST_SINGLE_TENANT_OCCUPIED' USING ERRCODE = '23514', CONSTRAINT = 'hosts_single_tenant_occupied';
  END IF;
  IF (new_assignment OR NEW.cpu > OLD.cpu) AND NEW.cpu > cap_cpu THEN
    RAISE EXCEPTION 'HOST_CUSTOMER_CPU_EXCEEDED' USING ERRCODE = '23514', CONSTRAINT = 'hosts_customer_cpu_limit';
  END IF;
  IF (new_assignment OR NEW.memory > OLD.memory) AND NEW.memory > cap_memory THEN
    RAISE EXCEPTION 'HOST_CUSTOMER_MEMORY_EXCEEDED' USING ERRCODE = '23514', CONSTRAINT = 'hosts_customer_memory_limit';
  END IF;
  -- Instances store disk in MiB, while the dedicated customer's disk is GiB.
  IF (new_assignment OR NEW.disk > OLD.disk) AND cap_disk IS NOT NULL AND NEW.disk::BIGINT > cap_disk::BIGINT * 1024 THEN
    RAISE EXCEPTION 'HOST_CUSTOMER_DISK_EXCEEDED' USING ERRCODE = '23514', CONSTRAINT = 'hosts_customer_disk_limit';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "enforce_single_tenant_host" BEFORE INSERT OR UPDATE OF host_id, status, provisioning_cleanup_pending, deletion_billing_pending, cpu, memory, disk
ON "instances" FOR EACH ROW EXECUTE FUNCTION "check_single_tenant_host"();
