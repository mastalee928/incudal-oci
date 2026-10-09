#!/usr/bin/env python3
import importlib.util
import ipaddress
import json
import pathlib
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("gateway", pathlib.Path(__file__).with_name("onboarding-gateway.py"))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="incudal-gateway-test-")
        self.addCleanup(self.temp.cleanup)
        directory = pathlib.Path(self.temp.name)
        gateway.STATE = directory / "state"
        gateway.STATE.mkdir()
        gateway.CONFIG = directory / "wg.conf"
        self.config = "[Interface]\nPrivateKey = test-fixture-only\nAddress = 10.253.240.1/24\n\n[Peer]\nPublicKey = existing-peer\nAllowedIPs = 10.253.240.2/32\n"
        gateway.CONFIG.write_text(self.config)
        self.control = ipaddress.ip_interface("10.253.240.1/24")
        self.job = "11111111-1111-4111-8111-111111111111"
        self.runner = mock.patch.object(gateway, "run", return_value="").start()
        self.addCleanup(mock.patch.stopall)

    def register(self, key="new-peer", job=None):
        return gateway.register_peer(job or self.job, key, self.control, gateway.CONFIG.read_text(), {})

    def test_preserves_existing_peers_and_resumes_the_same_address(self):
        self.assertEqual(self.register(), "10.253.240.3")
        self.assertEqual(self.register(), "10.253.240.3")
        config = gateway.CONFIG.read_text()
        self.assertIn(self.config.rstrip(), config)
        self.assertEqual(config.count("# incudal-onboarding"), 1)
        saved = json.loads((gateway.STATE / (self.job + ".json")).read_text())
        self.assertEqual(saved["nodePublicKey"], "new-peer")

    def test_crash_after_reservation_can_resume_without_double_allocation(self):
        self.runner.side_effect = RuntimeError("simulated WireGuard failure")
        with self.assertRaises(RuntimeError):
            self.register()
        self.runner.side_effect = None
        self.assertEqual(self.register(), "10.253.240.3")
        self.assertEqual(self.register("second-peer", "22222222-2222-4222-8222-222222222222"), "10.253.240.4")

    def test_key_change_or_duplicate_registration_cannot_steal_an_address(self):
        self.register()
        before = gateway.CONFIG.read_text()
        with self.assertRaises(ValueError):
            self.register("changed-key")
        with self.assertRaises(ValueError):
            self.register("new-peer", "22222222-2222-4222-8222-222222222222")
        self.assertEqual(gateway.CONFIG.read_text(), before)

    def test_saved_configuration_reserves_entire_ranges_while_device_is_down(self):
        gateway.CONFIG.write_text(self.config.replace("10.253.240.2/32", "10.253.240.0/30, 10.253.240.4/32, fd00::/64"))
        self.assertEqual(self.register(), "10.253.240.5")

    def test_other_reservations_remain_occupied_before_wireguard_is_updated(self):
        (gateway.STATE / "other.json").write_text(json.dumps({"managementIp": "10.253.240.3", "nodePublicKey": "other-peer"}))
        self.assertEqual(self.register(), "10.253.240.4")

    def test_forced_command_rejects_shell_commands_and_traversal(self):
        for command in ["status; id", "add ../../etc/passwd key", "sh", "status extra"]:
            with mock.patch.dict(gateway.os.environ, {"SSH_ORIGINAL_COMMAND": command}):
                with self.assertRaises(ValueError):
                    gateway.main()
        self.runner.assert_not_called()


if __name__ == "__main__":
    unittest.main()
