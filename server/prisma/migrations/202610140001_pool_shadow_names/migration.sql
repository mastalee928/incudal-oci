-- 影子套餐/方案改用客户可读名，并用 shadow_plan_id 精确关联价格行（不再依赖名字里带 ID）。
-- 旧方案名形如「池子 #<价格行ID>」，旧套餐名形如「[池子] <预设>」。

ALTER TABLE "host_pool_prices" ADD COLUMN "shadow_plan_id" INTEGER;

-- 回填：把「池子 #<价格行ID>」对应的影子方案挂到价格行上
UPDATE "host_pool_prices" p
SET "shadow_plan_id" = pl."id"
FROM "package_plans" pl
JOIN "packages" pkg ON pkg."id" = pl."package_id"
WHERE pl."name" = '池子 #' || p."id"
  AND pkg."hidden" = true
  AND pkg."name" = '[池子] ' || p."resource_preset";

-- 方案改名：地区 · 磁盘档
UPDATE "package_plans" pl
SET "name" = rg."name" || ' · ' || p."disk_gib" || 'G'
FROM "host_pool_prices" p
JOIN "host_region_groups" rg ON rg."id" = p."region_group_id"
WHERE pl."id" = p."shadow_plan_id";

-- 套餐改名与描述：独立机型 <预设>
UPDATE "packages"
SET "name" = '独立机型 ' || substring("name" from 6),
    "description" = '系统生成的计费套餐，不对用户展示'
WHERE "hidden" = true AND "name" LIKE '[池子] %';
