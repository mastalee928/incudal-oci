-- 池子价格：一机一卖的商品与定价。纯结构迁移，不动数据。
CREATE TABLE "host_pool_prices" (
  "id" SERIAL PRIMARY KEY,
  "machine_group_id" INTEGER NOT NULL,
  "resource_preset" TEXT NOT NULL,
  "region_group_id" INTEGER NOT NULL,
  "disk_gib" INTEGER NOT NULL,
  "name" TEXT,
  "monthly_price" DECIMAL(10,2) NOT NULL,
  "setup_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
ALTER TABLE "host_pool_prices"
  ADD CONSTRAINT "host_pool_prices_machine_group_id_fkey" FOREIGN KEY ("machine_group_id") REFERENCES "host_machine_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "host_pool_prices_region_group_id_fkey" FOREIGN KEY ("region_group_id") REFERENCES "host_region_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "host_pool_prices_pool_key"
  ON "host_pool_prices"("machine_group_id", "resource_preset", "region_group_id", "disk_gib");
CREATE INDEX "host_pool_prices_region_group_id_idx" ON "host_pool_prices"("region_group_id");
CREATE INDEX "host_pool_prices_active_idx" ON "host_pool_prices"("active");

ALTER TABLE "instances" ADD COLUMN "pool_price_id" INTEGER;
ALTER TABLE "instances"
  ADD CONSTRAINT "instances_pool_price_id_fkey" FOREIGN KEY ("pool_price_id") REFERENCES "host_pool_prices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "instances_pool_price_id_idx" ON "instances"("pool_price_id");

ALTER TABLE "packages" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "packages_hidden_idx" ON "packages"("hidden");
