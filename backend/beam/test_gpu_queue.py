"""Offline GPU queue, warm-up and resident protocol regression checks (no GPU/network)."""
import concurrent.futures
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from PIL import Image

import gateway
import security
import storage
import worker

CALL = "0123456789abcdef0123456789abcdef"
JOB = "fedcba9876543210fedcba9876543210"
TASK = "01234567-89ab-cdef-0123-456789abcdef"
NOW = 2000000000.0


class GPUQueueTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="gpu-queue-test-", dir=Path(__file__).parent)
        self.root = Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        for item in (
            patch.object(storage, "ROOT", self.root),
            patch.object(security, "ROOT", self.root),
            patch.object(worker, "ROOT", self.root),
            patch.dict(os.environ, {"RUHUA_GPU_URL": "https://offline.invalid/tasks",
                                    "BEAM_API_TOKEN": "offline-test-only-not-a-real-token",
                                    "RUHUA_DAILY_WARMS": "60", "RUHUA_MAX_PENDING": "3",
                                    "RUHUA_DAILY_JOBS": "30", "TORCH_HOME": "", "HF_HOME": "",
                                    "TORCH_EXTENSIONS_DIR": "", "SHARP_CKPT": "",
                                    "RUHUA_STATE_MAP": ""}),
            patch.object(gateway.requests, "post", side_effect=AssertionError("unexpected network POST")),
            patch.object(gateway.requests, "get", side_effect=AssertionError("unexpected network GET")),
            patch.object(gateway.time, "time", return_value=NOW),
        ):
            item.start()
            self.addCleanup(item.stop)
        self.client = TestClient(gateway.create_app())

    def queued(self, waited=20, dispatches=1):
        storage.write_state(CALL, "queued", job_id=JOB, stage="original")
        storage.atomic_json(gateway.task_record_path(CALL), {
            "task_id": TASK, "payload": {"job_id": JOB, "source": "original.jpg"},
            "dispatches": dispatches, "dispatched_at": NOW - waited})
        return storage.read_state(CALL)

    def test_dispatch_records_payload_task_id_and_dispatch_count(self):
        payload = {"job_id": JOB, "source": "original.jpg", "render_video": False, "enhanced": False}
        with patch.object(gateway, "dispatch", return_value=TASK) as dispatch:
            self.assertEqual(gateway.dispatch_job(CALL, **payload), TASK)
            record = storage.read_json(self.root / "beam-tasks" / (CALL + ".json"))
            self.assertEqual(record, {"task_id": TASK, "payload": payload, "dispatches": 1, "dispatched_at": NOW})
            gateway.dispatch_job(CALL, **payload)
        dispatch.assert_called_with(call_id=CALL, **payload)
        self.assertEqual(storage.read_json(gateway.task_record_path(CALL))["dispatches"], 2)

    def test_under_fifteen_seconds_does_not_query_beam(self):
        state = self.queued(waited=14.999)
        with patch.object(gateway, "beam_task") as beam:
            self.assertIs(gateway.watch_queue(CALL, state), state)
        beam.assert_not_called()

    def test_pending_and_running_stages(self):
        state = self.queued()
        for status, text in [("PENDING", "正在唤醒云端 GPU"), ("RUNNING", "已启动 · 正在载入模型")]:
            with self.subTest(status=status), patch.object(gateway, "beam_task", return_value={"status": status, "started_at": ""}):
                self.assertIn(text, gateway.watch_queue(CALL, state)["stage"])
        self.assertEqual(storage.read_state(CALL), state)

    def test_dead_tasks_retry_once_then_error(self):
        for status in ["FAILED", "ERROR", "EXPIRED", "TIMEOUT", "CANCELLED", "COMPLETE"]:
            with self.subTest(status=status):
                state = self.queued(waited=31)
                with patch.object(gateway, "beam_task", return_value={"status": status, "started_at": ""}), patch.object(gateway, "dispatch", return_value=TASK) as dispatch:
                    self.assertIn("自动重新排队", gateway.watch_queue(CALL, state)["stage"])
                    self.assertEqual(storage.read_json(gateway.task_record_path(CALL))["dispatches"], 2)
                    record = storage.read_json(gateway.task_record_path(CALL))
                    record["dispatched_at"] = NOW - 31
                    storage.atomic_json(gateway.task_record_path(CALL), record)
                    result = gateway.watch_queue(CALL, storage.read_state(CALL))
                dispatch.assert_called_once()
                self.assertEqual(result["status"], "error")
                self.assertEqual(result["job_id"], JOB)

    def test_complete_at_thirty_seconds_does_not_retry(self):
        state = self.queued(waited=30)
        with patch.object(gateway, "beam_task", return_value={"status": "COMPLETE", "started_at": ""}), patch.object(gateway, "dispatch_job") as dispatch:
            self.assertEqual(gateway.watch_queue(CALL, state)["status"], "queued")
        dispatch.assert_not_called()

    def test_beam_api_failure_returns_original_state(self):
        state = self.queued()
        gateway._beam_cache.clear()
        self.addCleanup(gateway._beam_cache.clear)
        with patch.object(gateway.requests, "get", side_effect=gateway.requests.ConnectionError("offline")) as request:
            self.assertIs(gateway.watch_queue(CALL, state), state)
        request.assert_called_once()

    def test_unconfigured_warm_does_not_dispatch(self):
        for name in ("RUHUA_GPU_URL", "BEAM_API_TOKEN"):
            with self.subTest(name=name), patch.dict(os.environ, {name: ""}), patch.object(gateway, "dispatch") as dispatch:
                self.assertEqual(self.client.post("/warm").json(), {"warming": False})
                dispatch.assert_not_called()

    def test_warm_ip_limit_is_six_per_minute_and_resets(self):
        with patch.object(gateway, "warm_up", return_value={"warming": True}) as warm:
            for _ in range(6):
                self.assertEqual(self.client.post("/warm").json(), {"warming": True})
            self.assertEqual(self.client.post("/warm").json(), {"warming": False, "throttled": True})
            with patch.object(gateway.time, "time", return_value=NOW + 60):
                self.assertEqual(self.client.post("/warm").json(), {"warming": True})
        self.assertEqual(warm.call_count, 7)

    def test_existing_warm_only_extends_window(self):
        for status in ("warming", "warm"):
            with self.subTest(status=status):
                storage.write_state(CALL, status, ready=True)
                state = storage.read_state(CALL)
                original = {"call_id": CALL, "dispatched_at": NOW - 30, "until": NOW + 10}
                storage.atomic_json(self.root / "gpu-warm.json", original)
                with patch.object(gateway, "dispatch") as dispatch:
                    self.assertEqual(self.client.post("/warm").json(), {"warming": True, "extended": True})
                dispatch.assert_not_called()
                self.assertEqual(storage.read_json(self.root / "gpu-warm.json"), {**original, "until": NOW + gateway.WARM_WINDOW})
                self.assertEqual(storage.read_state(CALL), state)
                self.assertFalse(list((self.root / "limits").glob("2*.json")))

    def test_real_work_prevents_warm_dispatch(self):
        for status in ("queued", "running"):
            with self.subTest(status=status):
                storage.write_state(CALL, status, job_id=JOB)
                with patch.object(gateway, "dispatch") as dispatch:
                    self.assertEqual(self.client.post("/warm").json(), {"warming": False, "busy": True})
                dispatch.assert_not_called()

    def test_daily_warm_cap(self):
        with patch.dict(os.environ, {"RUHUA_DAILY_WARMS": "1"}), patch.object(gateway, "dispatch", return_value=TASK) as dispatch:
            self.assertEqual(self.client.post("/warm").json(), {"warming": True})
            call_id = storage.read_json(self.root / "gpu-warm.json")["call_id"]
            storage.write_state(call_id, "done", warm=True)
            self.assertEqual(self.client.post("/warm").json(), {"warming": False, "capped": True})
        dispatch.assert_called_once_with(call_id=call_id, warm=True)
        ledgers = list((self.root / "limits").glob("2*.json"))
        self.assertEqual(len(ledgers), 1)
        self.assertEqual(storage.read_json(ledgers[0])["warms"], 1)

    def test_warm_dispatch_failure_is_terminal(self):
        with patch.object(gateway, "dispatch", side_effect=gateway.HTTPException(503, "offline")):
            self.assertEqual(gateway.warm_up(), {"warming": False})
        call_id = storage.read_json(self.root / "gpu-warm.json")["call_id"]
        self.assertEqual(storage.read_state(call_id)["status"], "error")

    def test_reserve_ignores_warm_states_but_limits_real_work(self):
        for index, status in enumerate(("warming", "warm", "done", "error"), 1):
            storage.write_state(f"{index:032x}", status)
        with patch.dict(os.environ, {"RUHUA_MAX_PENDING": "1"}):
            storage.reserve(CALL, JOB)
            self.assertEqual(storage.read_state(CALL)["status"], "queued")
            with self.assertRaises(storage.CapacityError):
                storage.reserve("a" * 32, JOB)

    def test_job_reservation_writes_demand_but_edit_does_not(self):
        storage.reserve(CALL, JOB, "edits")
        self.assertFalse((self.root / "gpu-demand.json").exists())
        storage.reserve(CALL, JOB)
        self.assertEqual(storage.read_json(self.root / "gpu-demand.json"), {"at": NOW, "call_id": CALL})

    def test_worker_rejects_unadmitted_or_wrong_state_warm(self):
        for status in (None, "queued", "running", "warm", "done", "error"):
            with self.subTest(status=status), patch.object(worker, "wait_model_server") as wait:
                if status:
                    storage.write_state(CALL, status)
                with self.assertRaises(ValueError):
                    worker.warm(CALL)
                wait.assert_not_called()

    def test_worker_warm_yields_to_new_demand_without_sleep(self):
        storage.write_state(CALL, "warming")
        storage.atomic_json(self.root / "gpu-demand.json", {"at": NOW + 1})
        storage.atomic_json(self.root / "gpu-warm.json", {"until": NOW + 150})
        with patch.object(worker, "wait_model_server", return_value={"load_seconds": 2}) as wait, patch.object(worker.time, "sleep") as sleep:
            self.assertEqual(worker.warm(CALL), {"warm": True, "ready": True})
        wait.assert_called_once()
        sleep.assert_not_called()
        self.assertEqual(storage.read_state(CALL)["status"], "done")
        self.assertEqual(storage.read_state(CALL)["held_seconds"], 0)

    def test_worker_warm_exits_after_window_expires(self):
        storage.write_state(CALL, "warming")
        storage.atomic_json(self.root / "gpu-demand.json", {"at": NOW - 60})
        storage.atomic_json(self.root / "gpu-warm.json", {"until": NOW - 1})
        with patch.object(worker, "wait_model_server", return_value=None), patch.object(worker.time, "sleep") as sleep:
            self.assertEqual(worker.warm(CALL), {"warm": True, "ready": False})
        sleep.assert_not_called()
        self.assertEqual(storage.read_state(CALL)["status"], "done")

    def test_process_resident_false_runs_cli_and_keeps_output_contract(self):
        directory = storage.job_path(JOB)
        directory.mkdir(parents=True)
        Image.new("RGB", (8, 6), "red").save(directory / "original.jpg")
        storage.write_state(CALL, "queued", job_id=JOB)

        def cli(command, **kwargs):
            self.assertEqual(Path(command[1]).name, "run_sharp.py")
            self.assertEqual(kwargs, {"capture_output": True, "text": True, "timeout": 840})
            self.assertEqual(command[command.index("--call-id") + 1], CALL)
            self.assertEqual(command[command.index("--job-id") + 1], JOB)
            Path(command[command.index("-o") + 1], "photo.ply").write_bytes(b"fake ply")
            Path(command[command.index("--timings") + 1]).write_text(json.dumps({"seconds": {"inference_seconds": 1.5}, "runtime": {"resident_model": False}}))
            return subprocess.CompletedProcess(command, 0, "", "")

        def preview(source, output):
            Path(output).write_bytes(b"s" * 32)
            return {"splat_count": 1, "preview_seconds": .1}

        with patch.object(worker, "predict_resident", return_value=False) as resident, patch.object(worker, "sharp_interpreter", return_value="offline-python"), patch.object(worker.subprocess, "run", side_effect=cli) as run, patch("preview.convert_ply_to_splat", side_effect=preview):
            result = worker.process(CALL, JOB, enhanced=True)
        resident.assert_called_once()
        run.assert_called_once()
        self.assertEqual(result["ply_file"], "scene_" + CALL + ".ply")
        self.assertEqual(result["viewer_file"], "scene_" + CALL + ".splat")
        self.assertEqual((directory / result["ply_file"]).read_bytes(), b"fake ply")
        self.assertEqual((directory / result["viewer_file"]).stat().st_size, 32)
        self.assertEqual(result["job_id"], JOB)
        self.assertTrue(result["enhanced"])
        self.assertIsNone(result["mp4_file"])
        self.assertEqual(result["timings"], {"inference_seconds": 1.5})
        self.assertFalse(result["runtime"]["resident_model"])
        for key in ("predict_seconds", "total_seconds"):
            self.assertGreaterEqual(result[key], 0)
        self.assertEqual(storage.read_state(CALL), {"status": "done", "updated_at": NOW, **result})


    def test_regression_stale_queue_poll_preserves_worker_done(self):
        # Regression: a queued snapshot from before the Beam request must never
        # overwrite a newly completed worker state.
        state = self.queued(waited=31, dispatches=2)

        def complete_while_polling(task_id):
            storage.write_state(CALL, "done", job_id=JOB, ply_file="scene_" + CALL + ".ply")
            return {"status": "COMPLETE", "started_at": ""}

        with patch.object(gateway, "beam_task", side_effect=complete_while_polling):
            result = gateway.watch_queue(CALL, state)
        self.assertEqual(result["status"], "done")
        self.assertEqual(storage.read_state(CALL)["status"], "done")

    def test_regression_concurrent_polls_redispatch_at_most_once(self):
        # Regression: simultaneous polls must claim the retry at most once.
        # Synchronize outside watch_queue so a future admission lock cannot
        # deadlock the test. Simulate network latency after the record read.
        # Fixture errors are checked in cleanup so a Barrier timeout cannot
        # masquerade as a product assertion failure.
        state = self.queued(waited=31, dispatches=1)
        barrier = threading.Barrier(2)
        fixture_errors = []
        self.addCleanup(lambda: self.assertEqual(fixture_errors, [], "concurrency fixture failed"))

        def failed_task(task_id):
            gateway.time.sleep(.05)
            return {"status": "FAILED", "started_at": ""}

        def poll(index):
            try:
                barrier.wait(timeout=5)
                return gateway.watch_queue(CALL, state)
            except Exception as error:
                fixture_errors.append(repr(error))
                return None

        with patch.object(gateway, "beam_task", side_effect=failed_task), patch.object(gateway, "dispatch", return_value=TASK) as dispatch:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(poll, range(2)))
        self.assertEqual(dispatch.call_count, 1)

    def test_regression_model_server_popen_failure_returns_false_for_cli(self):
        # Regression: a wait_model_server/start_model_server launch failure
        # must return False so process can execute the working CLI path.
        # Exercise the real launch path, mocking only the OS subprocess boundary.
        with patch.object(worker, "_server", None), patch.object(worker, "_server_ready", None), patch.object(worker, "_server_lines", None), patch.object(worker, "sharp_interpreter", return_value="offline-python"), patch.object(worker.subprocess, "Popen", side_effect=OSError("simulated resident launch failure")):
            self.assertFalse(worker.predict_resident({"call_id": CALL, "job_id": JOB}))


    def test_regression_failed_map_write_does_not_mask_newer_volume_state(self):
        # Regression: after one failed hot write, an older Map value must not
        # shadow the newer durable state. No Beam SDK or gRPC.
        class FakeMap:
            def __init__(self):
                self.values = {}
                self.fail_writes = False

            def set(self, key, value, ttl=None):
                if self.fail_writes:
                    raise RuntimeError("simulated transient Map write failure")
                self.values[key] = value

            def get(self, key):
                return self.values.get(key)

        hot = FakeMap()
        with patch.object(storage, "_hot_map", return_value=hot):
            storage.write_state(CALL, "queued", job_id=JOB)
            hot.fail_writes = True
            # The durable record is newer, matching successive real writes.
            with patch.object(storage.time, "time", return_value=NOW + 1):
                storage.write_state(CALL, "done", job_id=JOB)
            self.assertEqual(storage.read_json(storage.state_path(CALL))["status"], "done")
            self.assertEqual(storage.read_state(CALL)["status"], "done")



class ResidentProtocolTests(unittest.TestCase):
    def test_fake_model_ready_result_error_and_clean_stdout_without_torch(self):
        # Run in a child: importing sharp_server intentionally redirects fd 1.
        # This executes its real main/reply and fd redirection with a fake Model.
        script = r'''
import io, json, runpy, sys
namespace = runpy.run_path(sys.argv[1], run_name="offline_protocol_test")
class FakeModel:
    def __init__(self):
        print("fake library startup log", flush=True)
        self.ready = {"device": "fake GPU", "load_seconds": 0}
    def run(self, request):
        print("fake inference log", flush=True)
        if request.get("fail"):
            raise RuntimeError("fake inference failed")
        return {"value": request["value"]}
namespace["main"].__globals__["Model"] = FakeModel
sys.stdin = io.StringIO('\n{"value": 42}\n{"fail": true}\n')
namespace["main"]()
assert "torch" not in sys.modules
'''
        result = subprocess.run([sys.executable, "-c", script, str(Path(__file__).with_name("sharp_server.py"))], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 3, result.stdout)
        self.assertEqual(json.loads(lines[0].removeprefix("READY ")), {"device": "fake GPU", "load_seconds": 0})
        self.assertEqual(json.loads(lines[1].removeprefix("RESULT ")), {"value": 42})
        self.assertEqual(lines[2], "ERROR RuntimeError: fake inference failed")
        self.assertIn("fake library startup log", result.stderr)
        self.assertIn("fake inference log", result.stderr)
        self.assertNotIn("fake library", result.stdout)


if __name__ == "__main__":
    unittest.main()
