"""Bootstrap regression tests. No MLX, installation, network, or real weights."""

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import setup


def checkpoint(path):
    path.mkdir(parents=True, exist_ok=True)
    for filename in (*setup.REQUIRED_FILES, "tokenizer.json", "model.safetensors"):
        (path / filename).touch()
    return path


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.venv = Path(self.temp.name) / "venv"
        self.runtime = self.venv / "bin/python"

    def existing_venv(self):
        self.runtime.parent.mkdir(parents=True)
        self.runtime.touch()
        (self.venv / "pyvenv.cfg").touch()

    def test_equipped_configured_python_is_reused_without_installation(self):
        with patch("setup.has_dependencies", return_value=True), patch("setup.run_install") as install:
            self.assertEqual(setup.select_runtime(self.venv), Path(sys.executable).absolute())
            install.assert_not_called()

    def test_readiness_check_uses_configured_python_without_creating_files(self):
        with patch("setup.has_dependencies", return_value=True), patch("setup.run_install") as install:
            self.assertEqual(setup.select_runtime(self.venv, install=False), Path(sys.executable).absolute())
            install.assert_not_called()
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_readiness_check_uses_managed_runtime_without_a_lock_or_install(self):
        self.existing_venv()
        with patch("setup.has_dependencies", side_effect=[False, True]), patch("setup.run_install") as install:
            self.assertEqual(setup.select_runtime(self.venv, install=False), self.runtime)
            install.assert_not_called()
        self.assertFalse((self.venv.parent / "venv.lock").exists())

    def test_missing_environment_check_does_not_create_or_install_anything(self):
        with patch("setup.has_dependencies", return_value=False), patch("setup.run_install") as install, \
                self.assertRaisesRegex(setup.SetupError, "/clef install"):
            setup.select_runtime(self.venv, install=False)
        install.assert_not_called()
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_broken_managed_environment_check_does_not_repair_it(self):
        self.existing_venv()
        with patch("setup.has_dependencies", return_value=False), patch("setup.run_install") as install, \
                self.assertRaisesRegex(setup.SetupError, "/clef install"):
            setup.select_runtime(self.venv, install=False)
        install.assert_not_called()
        self.assertFalse((self.venv.parent / "venv.lock").exists())

    def test_managed_runtime_is_reused_without_installation(self):
        self.existing_venv()
        with patch("setup.has_dependencies", side_effect=[False, True]), patch("setup.run_install") as install:
            self.assertEqual(setup.select_runtime(self.venv), self.runtime)
            install.assert_not_called()

    def test_missing_dependencies_create_and_install_only_in_managed_venv(self):
        with patch("setup.has_dependencies", side_effect=[False, False, True]), \
                patch("setup.run_install") as install, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(setup.select_runtime(self.venv), self.runtime)
            commands = [call.args[0] for call in install.call_args_list]
            self.assertEqual(commands[0], [str(Path(sys.executable).absolute()), "-m", "venv", str(self.venv)])
            self.assertEqual(commands[1], [str(self.runtime), "-m", "ensurepip", "--upgrade"])
            self.assertEqual(commands[2], [str(self.runtime), "-m", "pip", "install", "--upgrade", "mlx-vlm", "huggingface_hub"])

    def test_interrupted_creation_is_repaired_without_deleting_existing_files(self):
        self.runtime.parent.mkdir(parents=True)
        self.runtime.touch()
        marker = self.venv / "keep"
        marker.touch()
        with patch("setup.has_dependencies", side_effect=[False, True]), patch("setup.run_install") as install, \
                contextlib.redirect_stderr(io.StringIO()):
            setup.select_runtime(self.venv)
            self.assertEqual(install.call_args.args[0][1:3], ["-m", "venv"])
            self.assertTrue(marker.exists())

    def test_failed_import_after_install_is_actionable(self):
        self.existing_venv()
        with patch("setup.has_dependencies", return_value=False), patch("setup.run_install"), \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaisesRegex(setup.SetupError, "after installation"):
            setup.select_runtime(self.venv)

    def test_venv_symlink_identity_is_preserved(self):
        self.existing_venv()
        self.runtime.unlink()
        self.runtime.symlink_to(sys.executable)
        with patch.object(sys, "executable", str(self.runtime)), patch("setup.has_dependencies", return_value=True):
            self.assertEqual(setup.select_runtime(self.venv), self.runtime)

    def test_setup_lock_wraps_dependency_check(self):
        import fcntl
        with patch("fcntl.flock", wraps=fcntl.flock) as lock, \
                patch("setup.has_dependencies", side_effect=lambda _: lock.called), patch("setup.run_install") as install:
            setup.select_runtime(self.venv)
            lock.assert_called_once()
            self.assertEqual(lock.call_args.args[1], fcntl.LOCK_EX)
            install.assert_not_called()

    def test_probe_is_offline_and_diagnostics_are_not_captured(self):
        with patch("setup.subprocess.run", return_value=types.SimpleNamespace(returncode=0)) as run:
            self.assertTrue(setup.has_dependencies("/python"))
            self.assertEqual(run.call_args.kwargs["env"]["HF_HUB_OFFLINE"], "1")
            self.assertEqual(run.call_args.kwargs["stdout"], subprocess.DEVNULL)
        with patch("setup.subprocess.run", side_effect=FileNotFoundError()):
            self.assertFalse(setup.has_dependencies("/missing"))

    def test_install_error_is_sanitized_and_setup_can_retry(self):
        with patch("setup.subprocess.run", side_effect=subprocess.CalledProcessError(1, "private command")), \
                self.assertRaisesRegex(setup.SetupError, "safe failure"):
            setup.run_install(["/python"], "safe failure")
        with patch("setup.subprocess.run", return_value=types.SimpleNamespace(returncode=0)):
            setup.run_install(["/python"], "safe failure")


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = checkpoint(Path(self.temp.name) / "snapshot")
        self.download = Mock(return_value=str(self.path))
        hub = types.ModuleType("huggingface_hub")
        hub.snapshot_download = self.download
        self.modules = patch.dict(sys.modules, {"huggingface_hub": hub})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def test_pinned_cache_is_reused_offline_without_refresh(self):
        self.assertEqual(setup.resolve_checkpoint("repo", "pinned"), self.path)
        self.download.assert_called_once_with("repo", revision="pinned", local_files_only=True)

    def test_uncached_snapshot_downloads_exact_revision_once(self):
        self.download.side_effect = [RuntimeError("private exception"), str(self.path)]
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(setup.resolve_checkpoint("repo", "pinned"), self.path)
        self.assertEqual(self.download.call_count, 2)
        self.assertEqual(self.download.call_args.kwargs, {"revision": "pinned"})

    def test_readiness_check_only_reads_pinned_cache(self):
        self.assertEqual(setup.resolve_checkpoint("repo", "pinned", install=False), self.path)
        self.download.assert_called_once_with("repo", revision="pinned", local_files_only=True)

    def test_missing_or_incomplete_checkpoint_check_never_downloads(self):
        for result in (RuntimeError("private-token"), str(Path(self.temp.name) / "missing")):
            self.download.reset_mock()
            self.download.side_effect = [result]
            with self.assertRaisesRegex(setup.SetupError, "/clef install"):
                setup.resolve_checkpoint("repo", "pinned", install=False)
            self.download.assert_called_once_with("repo", revision="pinned", local_files_only=True)

    def test_incomplete_cache_downloads_missing_files(self):
        incomplete = Path(self.temp.name) / "incomplete"
        incomplete.mkdir()
        self.download.side_effect = [str(incomplete), str(self.path)]
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(setup.resolve_checkpoint("repo", "pinned"), self.path)
        self.assertEqual(self.download.call_count, 2)

    def test_local_model_never_downloads_or_falls_back(self):
        self.assertEqual(setup.resolve_checkpoint(str(self.path), "unused"), self.path)
        self.download.assert_not_called()
        (self.path / "tokenizer.json").unlink()
        with self.assertRaisesRegex(setup.SetupError, "modelPath"):
            setup.resolve_checkpoint(str(self.path), "unused")
        self.download.assert_not_called()

    def test_weight_and_tokenizer_checks_detect_incomplete_snapshots(self):
        (self.path / "model.safetensors").unlink()
        self.assertFalse(setup.complete_checkpoint(self.path))
        (self.path / "model-00001-of-00002.safetensors").touch()
        index = self.path / "model.safetensors.index.json"
        index.write_text(json.dumps({"weight_map": {"a": "model-00001-of-00002.safetensors", "b": "missing.safetensors"}}))
        self.assertFalse(setup.complete_checkpoint(self.path))
        (self.path / "missing.safetensors").touch()
        self.assertTrue(setup.complete_checkpoint(self.path))
        index.write_text("invalid JSON")
        self.assertFalse(setup.complete_checkpoint(self.path))

    def test_download_failure_does_not_expose_exception_details(self):
        self.download.side_effect = RuntimeError("secret-token")
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(setup.SetupError) as raised:
            setup.resolve_checkpoint("repo", "pinned")
        self.assertIn("network access", str(raised.exception))
        self.assertNotIn("secret-token", str(raised.exception))


class CliTests(unittest.TestCase):
    args = ["--model", "repo", "--revision", "pinned", "--venv", "/managed/venv"]

    def test_platform_and_version_fail_before_any_side_effects(self):
        with patch.object(sys, "platform", "linux"), patch("setup.select_runtime") as select, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(setup.main(self.args), 1)
            self.assertIn("Apple Silicon", json.loads(output.getvalue())["error"])
            select.assert_not_called()
        with patch.object(sys, "platform", "darwin"), patch("setup.platform.machine", return_value="arm64"), \
                patch.object(sys, "version_info", (3, 10, 0)), self.assertRaisesRegex(setup.SetupError, "3.11"):
            setup.check_platform()

    def test_success_is_one_json_result_and_runtime_does_not_install(self):
        with patch("setup.check_platform"), patch("setup.select_runtime") as select, \
                patch("setup.resolve_checkpoint", return_value=Path("/snapshot")), patch.dict(os.environ), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(setup.main(self.args + ["--runtime"]), 0)
            self.assertEqual(json.loads(output.getvalue()), {"python": str(Path(sys.executable).absolute()), "modelPath": "/snapshot"})
            select.assert_not_called()

    def test_managed_runtime_receives_pinned_arguments_and_online_environment(self):
        with patch("setup.check_platform"), patch("setup.select_runtime", return_value=Path("/managed/bin/python")), \
                patch("setup.subprocess.call", return_value=0) as run, \
                patch.dict(os.environ, {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}):
            self.assertEqual(setup.main(self.args), 0)
            command = run.call_args.args[0]
            self.assertEqual(command[0], "/managed/bin/python")
            self.assertIn("--runtime", command)
            self.assertEqual(command[-6:], self.args)
            self.assertNotIn("HF_HUB_OFFLINE", run.call_args.kwargs["env"])
            self.assertNotIn("TRANSFORMERS_OFFLINE", run.call_args.kwargs["env"])

    def test_invalid_local_path_does_not_install(self):
        with patch("setup.check_platform"), patch("setup.select_runtime") as select, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            args = ["--model", "/no-such-clef-model", "--revision", "pinned", "--venv", "/managed/venv"]
            self.assertEqual(setup.main(args), 1)
            self.assertIn("modelPath", json.loads(output.getvalue())["error"])
            select.assert_not_called()

    def test_check_mode_passes_offline_flags_and_cannot_install(self):
        with patch("setup.check_platform"), patch("setup.select_runtime", return_value=Path("/managed/bin/python")) as select, \
                patch("setup.subprocess.call", return_value=0) as run:
            self.assertEqual(setup.main(self.args + ["--check"]), 0)
            select.assert_called_once_with("/managed/venv", install=False)
            self.assertIn("--check", run.call_args.args[0])
            self.assertEqual(run.call_args.kwargs["env"]["HF_HUB_OFFLINE"], "1")
            self.assertEqual(run.call_args.kwargs["env"]["TRANSFORMERS_OFFLINE"], "1")

    def test_runtime_check_keeps_hub_offline_and_resolves_without_installing(self):
        def resolve(*args, **kwargs):
            self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
            self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
            self.assertEqual(kwargs, {"install": False})
            return Path("/snapshot")
        with patch("setup.check_platform"), patch("setup.select_runtime") as select, \
                patch("setup.resolve_checkpoint", side_effect=resolve), patch.dict(os.environ), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(setup.main(self.args + ["--runtime", "--check"]), 0)
            self.assertEqual(json.loads(output.getvalue())["modelPath"], "/snapshot")
            select.assert_not_called()

    def test_unexpected_errors_do_not_leak_arbitrary_details(self):
        with patch("setup.check_platform"), patch("setup.select_runtime", side_effect=RuntimeError("private-token")), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(setup.main(self.args), 1)
            self.assertNotIn("private-token", output.getvalue())


if __name__ == "__main__":
    unittest.main()
