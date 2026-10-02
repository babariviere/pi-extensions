"""Protocol and inference adapter tests. No installed MLX, downloads, or model weights."""

import argparse
import io
import json
import math
import sys
import types
import unittest
from unittest.mock import patch

import worker


def payload():
    return {"state": {"message": "private input"}, "temperature": 1, "questions": {
        "urgent": {"type": "noul", "instructions": "urgent?", "criteria": {"true": "yes", "false": "no"}},
        "team": {"type": "choice", "instructions": "team?", "criteria": {"a": "A", "b": "B"}},
        "severity": {"type": "score", "instructions": "severity?", "criteria": ["low", "high"]},
    }}


class ProtocolTests(unittest.TestCase):
    def run_requests(self, lines, infer):
        output, errors = io.StringIO(), io.StringIO()
        worker.serve(io.StringIO("".join(lines)), output, errors, infer)
        return [json.loads(line) for line in output.getvalue().splitlines()], errors.getvalue()

    def envelope(self, value=None, request_id=1):
        return json.dumps({"id": request_id, "payload": payload() if value is None else value}) + "\n"

    def test_serial_protocol_and_stdout_isolation(self):
        seen = []

        def infer(value):
            seen.append(value)
            print("library diagnostic")
            return {"probabilities": {"urgent": {"true": 0.9, "false": 0.1}}, "inputTokens": 10}

        replies, errors = self.run_requests([self.envelope(), self.envelope(request_id=2)], infer)
        self.assertEqual([reply["id"] for reply in replies], [1, 2])
        self.assertTrue(all(reply["ok"] for reply in replies))
        self.assertEqual(len(seen), 2)
        self.assertEqual(errors, "library diagnostic\nlibrary diagnostic\n")

    def test_invalid_payload_never_reaches_inference_and_recovers(self):
        invalid = payload()
        invalid["questions"]["urgent"]["type"] = "bool"
        calls = []
        replies, _ = self.run_requests([self.envelope(invalid), self.envelope()], lambda value: calls.append(value) or {})
        self.assertFalse(replies[0]["ok"])
        self.assertFalse(replies[0]["fatal"])
        self.assertTrue(replies[1]["ok"])
        self.assertEqual(len(calls), 1)

    def test_malformed_and_oversized_requests_fail_closed(self):
        for line in ["not json\n", "[]\n", "{}\n", "x" * (worker.MAX_BYTES + 2), '{"id":1,"payload":NaN}\n']:
            replies, _ = self.run_requests([line], lambda value: self.fail("must not infer"))
            self.assertFalse(replies[0]["ok"])

    def test_arbitrary_exception_does_not_echo_private_input(self):
        def infer(value):
            raise RuntimeError(value["state"]["message"])

        replies, errors = self.run_requests([self.envelope(), self.envelope()], infer)
        self.assertEqual(len(replies), 1)
        self.assertTrue(replies[0]["fatal"])
        self.assertNotIn("private input", replies[0]["error"])
        self.assertEqual(errors, "")

    def test_nonfinite_output_is_not_emitted_as_json(self):
        replies, _ = self.run_requests([self.envelope()], lambda value: {"p": float("nan")})
        self.assertFalse(replies[0]["ok"])
        self.assertTrue(replies[0]["fatal"])

    def test_payload_validation(self):
        for temperature in [0, -1, True, float("nan"), float("inf")]:
            value = payload()
            value["temperature"] = temperature
            with self.assertRaises(worker.WorkerError):
                worker.validate_payload(value)
        self.assertEqual(worker.validate_payload(payload()), payload())

    def test_missing_local_snapshot_is_an_explicit_fatal_setup_error(self):
        with self.assertRaises(worker.WorkerError) as raised:
            worker.resolve_checkpoint("/no-such-clef-snapshot", "revision")
        self.assertTrue(raised.exception.fatal)


class Array:
    def __init__(self, values):
        self.values = values

    def astype(self, dtype):
        return self

    def __truediv__(self, temperature):
        return Array([value / temperature for value in self.values])

    def tolist(self):
        return self.values


class InferenceTests(unittest.TestCase):
    def test_lazy_loader_reuse_temperature_limits_and_usage(self):
        loads, calls, memory_limits, cleared = [], [], [], []
        mlx, core = types.ModuleType("mlx"), types.ModuleType("mlx.core")
        core.float32 = "float32"
        core.set_memory_limit = memory_limits.append
        core.set_cache_limit = lambda value: None
        core.clear_cache = lambda: cleared.append(True)

        def softmax(array):
            exponentials = [math.exp(value) for value in array.values]
            return Array([value / sum(exponentials) for value in exponentials])

        core.softmax = softmax
        mlx.core = core
        encoded = types.SimpleNamespace(input_ids=[1, 2, 3], questions=[types.SimpleNamespace(question_id="urgent", option_ids=["true", "false"])])

        class Model:
            def logits(self, record, **kwargs):
                calls.append((record, kwargs))
                return encoded, [Array([2, 0])]

        module = types.ModuleType("clef_mlx")
        module.load = lambda path, backend: loads.append((path, backend)) or Model()
        spec = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda value: None))
        args = argparse.Namespace(model="repo", revision="pinned", max_length=8192, memory_limit_gb=16)
        with patch.object(sys, "platform", "darwin"), patch("worker.platform.machine", return_value="arm64"), \
                patch.dict(sys.modules, {"mlx": mlx, "mlx.core": core, "clef_mlx": module}), \
                patch("worker.resolve_checkpoint", return_value=__import__("pathlib").Path("/snapshot")), \
                patch("worker.importlib.util.spec_from_file_location", return_value=spec), \
                patch("worker.importlib.util.module_from_spec", return_value=module):
            infer = worker.create_infer(args)
            self.assertEqual(loads, [])
            value = payload()
            first = infer(value)
            value["temperature"] = 2
            second = infer(value)
            self.assertEqual(len(loads), 1)
            self.assertEqual(first["inputTokens"], 3)
            self.assertGreater(first["probabilities"]["urgent"]["true"], second["probabilities"]["urgent"]["true"])
            self.assertEqual(calls[0][1], {"max_length": 8192, "truncate": False})
            self.assertEqual(set(calls[0][0]), {"state", "questions"})
            self.assertEqual(memory_limits, [16 * 1024**3] * 2)
            self.assertEqual(len(cleared), 2)


if __name__ == "__main__":
    unittest.main()
