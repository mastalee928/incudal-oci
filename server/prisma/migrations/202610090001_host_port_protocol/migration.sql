ALTER TABLE "hosts"
  ADD COLUMN "port_protocol" TEXT NOT NULL DEFAULT 'tcp_udp',
  ADD COLUMN "port_protocol_revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "port_protocol_applied" TEXT NOT NULL DEFAULT 'tcp_udp',
  ADD COLUMN "port_protocol_applied_revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "port_protocol_error" TEXT;

ALTER TABLE "hosts" ADD CONSTRAINT "hosts_port_protocol_check"
  CHECK ("port_protocol" IN ('tcp', 'tcp_udp') AND "port_protocol_applied" IN ('tcp', 'tcp_udp'));
