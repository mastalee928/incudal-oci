-- 多台订单：同一次付款的实例与账单共用一个批次号，只用于归组展示与汇总通知，
-- 不参与任何计费判断。存量行全部为空值。
ALTER TABLE "instances" ADD COLUMN "purchase_batch_id" VARCHAR(32);
CREATE INDEX "instances_purchase_batch_id_idx" ON "instances"("purchase_batch_id");

ALTER TABLE "instance_billing_records" ADD COLUMN "purchase_batch_id" VARCHAR(32);
CREATE INDEX "instance_billing_records_purchase_batch_id_idx" ON "instance_billing_records"("purchase_batch_id");
