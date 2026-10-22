"""Offline checks for 「走进世界」 (World Labs proxy). No network: World Labs is mocked."""
import base64
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image

import security
import storage
import world

JOB = "0123456789abcdef0123456789abcdef"
OTHER = "fedcba9876543210fedcba9876543210"
OPERATION = "op_0123456789"
WORLD = "wld_abcdef0123"


def reply(status=200, body=None):
    response = MagicMock(status_code=status, ok=200 <= status < 300)
    response.json.return_value = body if body is not None else {}
    return response


def upstream(credits=7000, operation=None, world_body=None):
    """Fake World Labs: answers by method and path, records every call."""
    def handler(method, url, json=None, timeout=None, headers=None):
        path = url[len(world.API):]
        if path == "/credits":
            return reply(body={"remaining_credits": credits})
        if path == "/worlds:generate":
            return reply(body={"operation_id": OPERATION, "done": False})
        if path.startswith("/operations/"):
            return reply(body=operation or {"done": False, "metadata": {"progress": {"status": "IN_PROGRESS"}}})
        if path.startswith("/worlds/"):
            return reply(body=world_body or {"id": WORLD, "assets": {"splats": {"spz_urls": {"500k": "https://cdn.worldlabs.ai/a.spz"}}}})
        return reply(404)
    return MagicMock(side_effect=handler)


class WorldTests(unittest.TestCase):
    def setUp(self):
        self.workspace = Path(__file__).resolve().parent
        self.temporary = tempfile.TemporaryDirectory(prefix="world-test-", dir=self.workspace)
        self.root = Path(self.temporary.name).resolve()
        self.patches = [
            patch.object(storage, "ROOT", self.root), patch.object(security, "ROOT", self.root),
            patch.dict(os.environ, {"BEAM_API_TOKEN": "offline-test-only-not-a-real-token",
                                    "WORLDLABS_API_KEY": "offline-test-not-a-real-key"}),
        ]
        for item in self.patches:
            item.start()
        self.directory = storage.job_path(JOB)
        self.directory.mkdir(parents=True)
        # 竖拍照片：存成横的 3000×2000，EXIF 方向 6（顺时针转 90°）
        exif = Image.Exif()
        exif[0x0112] = 6
        Image.new("RGB", (3000, 2000), "#e17640").save(self.directory / "original.jpg", "JPEG", exif=exif)
        self.token = security.create_access(JOB)

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temporary.cleanup()

    def generate(self, payload, credits=7000):
        admit = MagicMock()
        with patch.object(world.requests, "request", upstream(credits)) as request:
            try:
                return world.generate(self.directory, JOB, payload, admit), request, admit
            except HTTPException as error:
                return error, request, admit

    # ---- 发起生成 ----
    def test_generate_sends_upright_shrunk_photo_privately(self):
        result, request, admit = self.generate({"model": "marble-1.0-draft", "text_prompt": "  黄昏的厨房  "})
        self.assertEqual(result, {"operation_id": OPERATION})
        admit.assert_called_once()
        method, url = request.call_args.args
        body, headers = request.call_args.kwargs["json"], request.call_args.kwargs["headers"]
        self.assertEqual((method, url), ("POST", world.API + "/worlds:generate"))
        self.assertEqual(headers["WLT-Api-Key"], "offline-test-not-a-real-key")
        self.assertEqual(body["model"], "marble-1.0-draft")
        self.assertEqual(body["permission"], {"public": False})
        self.assertEqual(body["display_name"], "Pixel Reconstruction " + JOB[:8])
        prompt = body["world_prompt"]
        self.assertEqual(prompt["text_prompt"], "黄昏的厨房")
        self.assertEqual(prompt["image_prompt"]["source"], "data_base64")
        with Image.open(io.BytesIO(base64.b64decode(prompt["image_prompt"]["data_base64"]))) as sent:
            self.assertEqual(sent.format, "JPEG")
            self.assertEqual(sent.size, (1365, 2048))  # 转正后竖着，长边缩到 2048
        record = storage.read_json(self.directory / "world.json")
        self.assertEqual(record["operations"][OPERATION]["model"], "marble-1.0-draft")

    def test_empty_prompt_is_left_out_and_default_model_is_standard(self):
        result, request, _ = self.generate({})
        body = request.call_args.kwargs["json"]
        self.assertEqual(body["model"], "marble-1.1")
        self.assertNotIn("text_prompt", body["world_prompt"])

    def test_invalid_requests_never_spend_or_call_upstream(self):
        cases = [{"model": "marble-9"}, {"text_prompt": "长" * 601},
                 {"image": "../access.json"}, {"image": "edit_" + "a" * 32 + ".jpg"}]
        for payload in cases:
            with self.subTest(payload=str(payload)[:40]):
                error, request, admit = self.generate(payload)
                self.assertIsInstance(error, HTTPException)
                self.assertEqual(error.status_code, 400)
                request.assert_not_called(); admit.assert_not_called()

    def test_low_balance_refuses_before_using_daily_quota(self):
        error, request, admit = self.generate({"model": "marble-1.1"}, credits=1000)
        self.assertEqual(error.status_code, 402)
        self.assertIn("速写", error.detail)
        admit.assert_not_called()
        self.assertEqual([call.args[1] for call in request.call_args_list], [world.API + "/credits"])

    def test_unconfigured_key_is_503(self):
        with patch.dict(os.environ, {"WORLDLABS_API_KEY": ""}):
            self.assertFalse(world.configured())
            error, request, admit = self.generate({})
        self.assertEqual(error.status_code, 503)
        request.assert_not_called(); admit.assert_not_called()

    def test_upstream_errors_are_mapped(self):
        for status, expected in [(401, 503), (403, 503), (402, 402), (429, 429), (500, 502)]:
            with self.subTest(status=status), patch.object(world.requests, "request", return_value=reply(status)):
                with self.assertRaises(HTTPException) as caught:
                    world.call("GET", "/credits")
                self.assertEqual(caught.exception.status_code, expected)
                self.assertNotIn("offline-test-not-a-real-key", caught.exception.detail)

    # ---- 查询进度、取世界：只认这件作品自己发起的任务 ----
    def test_operation_and_world_belong_to_their_job(self):
        self.generate({"model": "marble-1.0-draft"})
        with patch.object(world.requests, "request", upstream()) as request:
            with self.assertRaises(HTTPException) as caught:
                world.world(self.directory, WORLD)  # 任务还没报出 world_id
            self.assertEqual(caught.exception.status_code, 404)
            request.assert_not_called()
        done = {"done": True, "metadata": {"world_id": WORLD, "progress": {"status": "SUCCEEDED"}}, "response": {}}
        with patch.object(world.requests, "request", upstream(operation=done)):
            self.assertEqual(world.operation(self.directory, OPERATION), done)
            self.assertEqual(world.world(self.directory, WORLD)["id"], WORLD)
        # 另一件作品拿着同样的编号查不到
        other = storage.job_path(OTHER)
        other.mkdir(parents=True)
        with patch.object(world.requests, "request", upstream(operation=done)) as request:
            for lookup, value in [(world.operation, OPERATION), (world.world, WORLD), (world.operation, "../credits")]:
                with self.assertRaises(HTTPException) as caught:
                    lookup(other, value)
                self.assertEqual(caught.exception.status_code, 404)
            request.assert_not_called()

    def test_world_id_from_response_snapshot_is_recorded(self):
        self.generate({"model": "marble-1.0-draft"})
        for snapshot in ({"id": WORLD}, {"world_id": WORLD}):
            with self.subTest(snapshot=snapshot):
                storage.atomic_json(self.directory / "world.json", {"operations": {OPERATION: {"model": "marble-1.0-draft"}}})
                with patch.object(world.requests, "request", upstream(operation={"done": True, "response": snapshot})):
                    world.operation(self.directory, OPERATION)
                    self.assertEqual(world.world(self.directory, WORLD)["id"], WORLD)

    # ---- 提交编号：页面中途关掉也能找回，重复提交不重复花钱 ----
    def test_request_id_recovers_and_deduplicates(self):
        request = "req_0123456789abcdef"
        with self.assertRaises(HTTPException) as caught:
            world.lookup(self.directory, request)
        self.assertEqual(caught.exception.status_code, 404)
        first, _, admit = self.generate({"model": "marble-1.0-draft", "request_id": request})
        self.assertEqual(world.lookup(self.directory, request), {"operation_id": OPERATION, "model": "marble-1.0-draft"})
        again, upstream_calls, admit_again = self.generate({"model": "marble-1.0-draft", "request_id": request})
        self.assertEqual(again, first)
        upstream_calls.assert_not_called(); admit_again.assert_not_called()
        other = storage.job_path(OTHER)
        other.mkdir(parents=True)
        for directory, value in [(other, request), (self.directory, "../x"), (self.directory, "")]:
            with self.assertRaises(HTTPException) as caught:
                world.lookup(directory, value)
            self.assertEqual(caught.exception.status_code, 404)
        error, request_calls, _ = self.generate({"request_id": "bad id!"})
        self.assertEqual(error.status_code, 400)
        request_calls.assert_not_called()

    # ---- 网关路由 ----
    def test_routes_require_the_job_token_and_count_daily_worlds(self):
        from gateway import create_app
        client = TestClient(create_app())
        self.assertTrue(client.get("/healthz").json()["world"])
        with patch.object(world.requests, "request", upstream()) as request:
            denied = client.post("/world/generate", json={"job_id": JOB, "model": "marble-1.0-draft"})
            self.assertEqual(denied.status_code, 403)
            self.assertEqual(client.get(f"/world/operations/{OPERATION}?job_id={JOB}").status_code, 403)
            request.assert_not_called()
            headers = {"X-Ruhua-Token": self.token}
            with patch.dict(os.environ, {"RUHUA_DAILY_WORLDS": "1"}):
                first = client.post("/world/generate", json={"job_id": JOB, "model": "marble-1.0-draft"}, headers=headers)
                self.assertEqual(first.json(), {"operation_id": OPERATION})
                second = client.post("/world/generate", json={"job_id": JOB, "model": "marble-1.0-draft"}, headers=headers)
                self.assertEqual(second.status_code, 429)
            progress = client.get(f"/world/operations/{OPERATION}?job_id={JOB}", headers=headers)
            self.assertEqual(progress.status_code, 200)
            self.assertFalse(progress.json()["done"])
            self.assertEqual(client.get(f"/world/requests/req_unknown123?job_id={JOB}", headers=headers).status_code, 404)
            self.assertEqual(client.get(f"/world/requests/req_unknown123?job_id={JOB}").status_code, 403)
        with patch.dict(os.environ, {"WORLDLABS_API_KEY": ""}):
            self.assertFalse(client.get("/healthz").json()["world"])


if __name__ == "__main__":
    unittest.main()
