"""Offline checks for companion bug reports (工单); stdlib only, no cloud calls."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import security
import storage
import tickets


class TicketTests(unittest.TestCase):
    def setUp(self):
        self.workspace = Path(__file__).resolve().parent
        self.temporary = tempfile.TemporaryDirectory(prefix="tickets-test-", dir=self.workspace)
        self.root = Path(self.temporary.name).resolve()
        self.patches = [patch.object(storage, "ROOT", self.root), patch.object(security, "ROOT", self.root), patch.object(tickets, "ROOT", self.root),
                        patch.dict(os.environ, {"BEAM_API_TOKEN": "offline-test-only-not-a-real-token"})]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temporary.cleanup()

    def report(self, **extra):
        return {"title": "场景下载失败", "summary": "打开作品后一直显示正在恢复下载", "actual": "下载失败（403）",
                "severity": "high", "category": "download", **extra}

    def test_file_list_get_close(self):
        filed = tickets.file_report(self.report(), "203.0.113.5")
        self.assertTrue(filed["ok"])
        ticket_id = filed["ticket"]
        self.assertRegex(ticket_id, tickets.ID_PATTERN)
        listed = tickets.list_reports()["tickets"]
        self.assertEqual([t["id"] for t in listed], [ticket_id])
        self.assertEqual(tickets.get_report(ticket_id)["status"], "open")
        tickets.update_report(ticket_id, "fixed", "已在 v1.9.5 修复")
        self.assertEqual(tickets.list_reports()["tickets"], [])
        self.assertEqual(tickets.list_reports("all")["tickets"][0]["status"], "fixed")
        self.assertEqual(tickets.get_report(ticket_id)["notes"][0]["text"], "已在 v1.9.5 修复")

    def test_credentials_are_scrubbed_but_job_ids_kept(self):
        job = "a" * 32
        token = "Q" * 43
        filed = tickets.file_report(self.report(
            actual=f"GET https://x.app.beam.cloud/file/{job}/scene.splat?expires=1&sig={'f' * 64} token {token} sk-abcdefghijklmnop",
            diagnostics={"最近失败的请求": f"403 scene-file/{job}/scene.splat?sig={'e' * 64}"},
            conversation=[{"role": "user", "content": f"我的令牌是 {token}"}]), "203.0.113.6")
        saved = tickets.get_report(filed["ticket"])
        text = str(saved)
        self.assertIn(job, text)
        for secret in (token, "f" * 64, "e" * 64, "sk-abcdefghijklmnop"):
            self.assertNotIn(secret, text)

    def test_validation_and_limits(self):
        with self.assertRaises(tickets.TicketRejected):
            tickets.clean_report({"title": "", "summary": "x"})
        with self.assertRaises(tickets.TicketRejected):
            tickets.clean_report("not a dict")
        cleaned = tickets.clean_report(self.report(title="场景 " * 200, severity="urgent", category="hack", errors=["e"] * 50))
        self.assertEqual(len(cleaned["title"]), 80)
        self.assertEqual(cleaned["severity"], "normal")
        self.assertEqual(cleaned["category"], "other")
        self.assertEqual(len(cleaned["errors"]), 12)
        with self.assertRaises(tickets.TicketRejected):
            tickets.parse(b"x" * (tickets.MAX_TICKET_BODY + 1))

    def test_rate_limit_per_address(self):
        tickets.file_report(self.report(), "203.0.113.7")
        tickets.file_report(self.report(), "203.0.113.7")
        with self.assertRaises(tickets.TicketRejected) as caught:
            tickets.file_report(self.report(), "203.0.113.7")
        self.assertEqual(caught.exception.status, 429)

    def test_admin_key_required(self):
        with self.assertRaises(tickets.TicketRejected):
            tickets.authorize_admin("")
        with self.assertRaises(tickets.TicketRejected):
            tickets.authorize_admin("0" * 64)
        tickets.authorize_admin(tickets.admin_key())

    def test_bad_ids_rejected(self):
        for bad in ("../secrets", "20261103-000000-zzzzzz", "", "20261103-000000-abcdef"):
            with self.assertRaises(tickets.TicketRejected):
                tickets.get_report(bad)


if __name__ == "__main__":
    unittest.main()
