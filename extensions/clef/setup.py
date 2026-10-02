"""Prepare Clef without loading weights or executing checkpoint code.

stdout is one JSON result. Installs are isolated from the configured interpreter.
All subprocesses stay in the caller's process group for lifecycle cancellation.
"""

import argparse
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

REQUIRED_FILES = (
    "clef_mlx.py", "config.json", "joint_head.safetensors", "joint_head_config.json",
    "tokenizer_config.json", "processor_config.json",
)
PROBE = "import mlx.core; import mlx_vlm; import huggingface_hub"


class SetupError(Exception):
    pass


def check_platform():
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise SetupError("Local Clef MLX requires Apple Silicon macOS.")
    if sys.version_info < (3, 11):
        raise SetupError("Clef requires Python 3.11+. Set python in clef.json to a supported interpreter.")


def environment(offline=False):
    env = dict(os.environ)
    env.update(HF_HUB_DISABLE_TELEMETRY="1", PYTHONDONTWRITEBYTECODE="1", PIP_DISABLE_PIP_VERSION_CHECK="1")
    for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
        if offline:
            env[key] = "1"
        else:
            env.pop(key, None)
    return env


def has_dependencies(python):
    try:
        return subprocess.run(
            [str(python), "-B", "-c", PROBE], env=environment(offline=True),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        ).returncode == 0
    except OSError:
        return False


def run_install(command, message):
    try:
        subprocess.run(command, env=environment(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    except (OSError, subprocess.CalledProcessError):
        raise SetupError(message) from None


def select_runtime(venv, install=True):
    # Readiness checks must not create a virtualenv, lock file, or install packages.
    if not install:
        current = Path(sys.executable).absolute()
        if has_dependencies(current):
            return current
        venv = Path(venv).expanduser().absolute()
        runtime = venv / "bin/python"
        if runtime.is_file() and (venv / "pyvenv.cfg").is_file() and has_dependencies(runtime):
            return runtime
        raise SetupError("Clef Python dependencies are missing or unavailable. Run /clef install.")

    import fcntl

    venv = Path(venv).expanduser().absolute()
    venv.parent.mkdir(parents=True, exist_ok=True)
    # An adjacent file survives interrupted creation. Kernel locks release on exit.
    with (venv.parent / (venv.name + ".lock")).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # Do not resolve symlinks: doing so would turn a venv Python into its base Python.
        current = Path(sys.executable).absolute()
        if has_dependencies(current):
            return current
        runtime = venv / "bin/python"
        if not runtime.is_file() or not (venv / "pyvenv.cfg").is_file():
            print("Creating Clef's isolated Python environment...", file=sys.stderr)
            run_install([str(current), "-m", "venv", str(venv)],
                        "Cannot create Clef's virtualenv. Check Python's venv support and directory permissions.")
        if not has_dependencies(runtime):
            print("Installing Clef Python dependencies...", file=sys.stderr)
            run_install([str(runtime), "-m", "ensurepip", "--upgrade"],
                        "Cannot bootstrap pip in Clef's virtualenv. Check Python's ensurepip support.")
            run_install([str(runtime), "-m", "pip", "install", "--upgrade", "mlx-vlm", "huggingface_hub"],
                        "Cannot install Clef dependencies. Check network access, free disk space, and Python compatibility. Retry /clef install.")
            if not has_dependencies(runtime):
                raise SetupError("Clef dependencies could not be imported after installation. Check Python/MLX compatibility.")
        return runtime


def complete_checkpoint(path):
    path = Path(path)
    if not path.is_dir() or not all((path / name).is_file() for name in REQUIRED_FILES):
        return False
    if not any((path / name).is_file() for name in ("tokenizer.json", "tokenizer.model", "vocab.json")):
        return False
    if not any(file.is_file() and file.name != "joint_head.safetensors" for file in path.glob("*.safetensors")):
        return False
    index = path / "model.safetensors.index.json"
    if index.exists():
        try:
            shards = json.loads(index.read_text()).get("weight_map")
            if not isinstance(shards, dict) or not shards:
                return False
            if not all(isinstance(name, str) and Path(name).name == name and (path / name).is_file()
                       for name in shards.values()):
                return False
        except (OSError, ValueError, AttributeError):
            return False
    return True


def resolve_checkpoint(model, revision, install=True):
    if Path(model).is_absolute():
        path = Path(model)
        if not complete_checkpoint(path):
            raise SetupError("Clef modelPath is missing or incomplete. Check its weights, tokenizer, and loader files.")
        return path
    from huggingface_hub import snapshot_download

    try:
        path = Path(snapshot_download(model, revision=revision, local_files_only=True))
        if complete_checkpoint(path):
            return path
    except Exception:
        pass
    if not install:
        raise SetupError("Clef checkpoint is missing or incomplete. Run /clef install.")
    print("Downloading Clef's pinned checkpoint (several GB)...", file=sys.stderr)
    try:
        path = Path(snapshot_download(model, revision=revision))
    except Exception:
        raise SetupError("Cannot download Clef's pinned checkpoint. Check network access and free disk space. Retry /clef install.") from None
    if not complete_checkpoint(path):
        raise SetupError("Clef's downloaded checkpoint is incomplete. Check free disk space and retry /clef install.")
    return path


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--venv", required=True)
    parser.add_argument("--check", action="store_true", help="Check readiness without installing or downloading")
    parser.add_argument("--runtime", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        check_platform()
        # Fail local-path mistakes before installing anything, and never fetch a fallback.
        if Path(args.model).is_absolute() and not complete_checkpoint(args.model):
            raise SetupError("Clef modelPath is missing or incomplete. Check its weights, tokenizer, and loader files.")
        if not args.runtime:
            runtime = select_runtime(args.venv, install=not args.check)
            if runtime != Path(sys.executable).absolute():
                return subprocess.call([
                    str(runtime), "-B", str(Path(__file__).absolute()),
                    "--runtime", "--model", args.model, "--revision", args.revision, "--venv", args.venv,
                    *(["--check"] if args.check else []),
                ], env=environment(offline=args.check))
        # Hub reads offline flags at import time. Only explicit installation goes online.
        for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
            if args.check:
                os.environ[key] = "1"
            else:
                os.environ.pop(key, None)
        path = resolve_checkpoint(args.model, args.revision, install=not args.check)
        print(json.dumps({"python": str(Path(sys.executable).absolute()), "modelPath": str(path.absolute())}))
        return 0
    except Exception as error:
        message = str(error) if isinstance(error, SetupError) else "Clef setup failed. Check Python, network access, and free disk space. Retry /clef install."
        print(json.dumps({"error": message}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
