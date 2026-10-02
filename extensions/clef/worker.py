"""Offline Clef MLX worker. stdout is exclusively the bounded JSON-lines protocol.

MLX and checkpoint code are imported only on the first valid classification.
The checkpoint's clef_mlx.py is trusted executable code, not just model weights.
"""

import argparse
import contextlib
import importlib.util
import json
import math
import platform
import sys
from pathlib import Path

MAX_BYTES = 4 * 1024 * 1024


class WorkerError(Exception):
    def __init__(self, message, fatal=False):
        super().__init__(message)
        self.fatal = fatal


def validate_payload(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("state"), dict):
        raise WorkerError("Clef requires JSON object state")
    questions = payload.get("questions")
    if not isinstance(questions, dict) or not 1 <= len(questions) <= 100:
        raise WorkerError("Clef requires 1 to 100 questions")
    temperature = payload.get("temperature", 1)
    if type(temperature) not in (int, float) or not math.isfinite(temperature) or temperature <= 0:
        raise WorkerError("Clef temperature must be positive")
    for question in questions.values():
        if not isinstance(question, dict) or not isinstance(question.get("instructions"), str):
            raise WorkerError("Invalid Clef question")
        kind, criteria = question.get("type"), question.get("criteria")
        if kind == "score":
            valid = isinstance(criteria, list)
        elif kind in ("choice", "noul"):
            valid = isinstance(criteria, dict)
            if kind == "noul":
                valid = valid and set(criteria) == {"true", "false"}
        else:
            valid = False
        if not valid or not 1 <= len(criteria) <= 256:
            raise WorkerError("Invalid Clef criteria")
        labels = criteria.values() if isinstance(criteria, dict) else criteria
        if not all(isinstance(label, str) for label in labels):
            raise WorkerError("Invalid Clef criteria")
    return payload


def resolve_checkpoint(model, revision):
    path = Path(model)
    if path.is_absolute():
        if not path.is_dir():
            raise WorkerError("Clef modelPath is not a directory. See the setup README.", fatal=True)
    else:
        try:
            from huggingface_hub import snapshot_download

            path = Path(snapshot_download(model, revision=revision, local_files_only=True))
        except Exception:
            raise WorkerError(
                "Clef checkpoint is not cached at the pinned revision. Retry /clef setup.",
                fatal=True,
            ) from None
    for filename in ("clef_mlx.py", "config.json", "joint_head.safetensors", "joint_head_config.json"):
        if not (path / filename).is_file():
            raise WorkerError("Clef checkpoint is incomplete. See the setup README.", fatal=True)
    return path


def create_infer(args):
    model, mx = None, None

    def infer(payload):
        nonlocal model, mx
        if model is None:
            if sys.platform != "darwin" or platform.machine() != "arm64":
                raise WorkerError("Local Clef MLX requires Apple Silicon macOS.", fatal=True)
            try:
                import mlx.core as mx
            except ImportError:
                raise WorkerError("Clef Python dependencies are unavailable after setup. Retry /clef setup.", fatal=True) from None
            path = resolve_checkpoint(args.model, args.revision)
            try:
                mx.set_memory_limit(args.memory_limit_gb * 1024**3)
                mx.set_cache_limit(256 * 1024**2)
                spec = importlib.util.spec_from_file_location("clef_mlx", path / "clef_mlx.py")
                module = importlib.util.module_from_spec(spec)
                sys.modules["clef_mlx"] = module
                spec.loader.exec_module(module)
                # The released checkpoint includes a vision tower even for text-only use.
                model = module.load(path, backend="vlm")
                mx.set_memory_limit(args.memory_limit_gb * 1024**3)
            except Exception as error:
                raise WorkerError(
                    f"Clef initialization failed ({type(error).__name__}). Check memory, the checkpoint, and current mlx-vlm support.",
                    fatal=True,
                ) from None
        record = {"state": payload["state"], "questions": payload["questions"]}
        try:
            encoded, logits = model.logits(record, max_length=args.max_length, truncate=False)
            probabilities = {
                question.question_id: dict(
                    zip(question.option_ids, mx.softmax(logit.astype(mx.float32) / payload.get("temperature", 1)).tolist())
                )
                for question, logit in zip(encoded.questions, logits)
            }
            return {"probabilities": probabilities, "inputTokens": len(encoded.input_ids)}
        except Exception as error:
            if type(error).__name__ == "ContextTooLong":
                raise WorkerError(f"Clef input exceeds {args.max_length} tokens. Shorten the state or questions.") from None
            raise WorkerError(
                f"Clef inference failed ({type(error).__name__}). Check available memory or reduce maxLength.", fatal=True
            ) from None
        finally:
            mx.clear_cache()

    return infer


def serve(input_stream, output_stream, error_stream, infer):
    while True:
        line = input_stream.readline(MAX_BYTES + 2)
        if not line:
            return
        request_id = None
        fatal = False
        try:
            if len(line.encode("utf-8")) > MAX_BYTES + 1 or not line.endswith("\n"):
                raise WorkerError("Clef request exceeds 4 MiB or is incomplete", fatal=True)
            request = json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Invalid JSON constant")))
            if not isinstance(request, dict) or type(request.get("id")) is not int:
                raise WorkerError("Invalid Clef request envelope")
            request_id = request["id"]
            payload = validate_payload(request.get("payload"))
            with contextlib.redirect_stdout(error_stream):
                result = infer(payload)
            response = {"id": request_id, "ok": True, "result": result}
            encoded = json.dumps(response, allow_nan=False, separators=(",", ":"))
            if len(encoded.encode("utf-8")) > MAX_BYTES:
                raise WorkerError("Clef response exceeds 4 MiB", fatal=True)
        except Exception as error:
            fatal = error.fatal if isinstance(error, WorkerError) else True
            # Never echo payloads, library tracebacks, or arbitrary exception text.
            message = str(error) if isinstance(error, WorkerError) else f"Clef worker failed ({type(error).__name__})"
            encoded = json.dumps({"id": request_id, "ok": False, "error": message, "fatal": fatal})
        output_stream.write(encoded + "\n")
        output_stream.flush()
        if fatal:
            return


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--max-length", type=int, required=True)
    parser.add_argument("--memory-limit-gb", type=int, required=True)
    args = parser.parse_args()
    serve(sys.stdin, sys.stdout, sys.stderr, create_infer(args))


if __name__ == "__main__":
    main()
