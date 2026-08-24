#!/usr/bin/env python3
"""Export LightOn mDenseOn to a local ONNX consumable by Agent V's code index.

mDenseOn has no public ONNX release (only SentenceTransformer safetensors on the
Hugging Face Hub), so it must be exported locally. This mirrors how DenseOn-ONNX
is loaded: the transformer backbone is exported with a `last_hidden_state`
output, and Agent V applies CLS pooling + `query:`/`document:` prefixes itself.

Usage:
    pip install "optimum[exporter]" torch sentence-transformers
    python scripts/export-mdenseon-onnx.py

Outputs into the app model dir:
    <userData>/codeindex/models/mDenseOn-onnx-int8/
        config.json, tokenizer.json, tokenizer_config.json,
        special_tokens_map.json, config_sentence_transformers.json,
        onnx/model_quantized.onnx

After running, set Settings -> Indexing -> Embedder = "LightOn dense (mDenseOn)".
The app never auto-downloads mDenseOn; it uses this exported ONNX when present.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

MODEL_ID = "lightonai/mDenseOn"
ARTIFACT_DIRNAME = "mDenseOn-onnx-int8"


def default_models_root() -> Path:
    """Match modelPaths.resolveUserDataRoot()/codeindex/models in the app."""
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        if base:
            return Path(base) / "vyotiq" / "codeindex" / "models"
    tmp = os.environ.get("TMPDIR") or os.environ.get("TEMP") or "/tmp"
    return Path(tmp) / "vyotiq-userdata" / "codeindex" / "models"


def export(model_id: str, out_dir: Path) -> None:
    try:
        from optimum.onnxruntime import ORTModelForFeatureExtraction
        from transformers import AutoTokenizer
    except ImportError as exc:  # pragma: no cover
        raise SystemExit(
            "Missing deps. Install with: pip install 'optimum[exporter]' torch transformers sentence-transformers"
        ) from exc

    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_subdir = out_dir / "onnx"
    onnx_subdir.mkdir(parents=True, exist_ok=True)

    print(f"[export] loading tokenizer + model from {model_id}")
    tokenizer = AutoTokenizer.from_pretrained(model_id)
    tokenizer.save_pretrained(str(out_dir))

    print("[export] converting backbone to ONNX (last_hidden_state)...")
    model = ORTModelForFeatureExtraction.from_pretrained(model_id, export=True)
    model.save_pretrained(str(out_dir))

    # optimum writes model.onnx at the root; relocate to onnx/model_quantized.onnx.
    root_onnx = out_dir / "model.onnx"
    target_onnx = onnx_subdir / "model_quantized.onnx"
    if root_onnx.exists():
        shutil.move(str(root_onnx), str(target_onnx))
    elif (onnx_subdir / "model.onnx").exists():
        shutil.move(str(onnx_subdir / "model.onnx"), str(target_onnx))

    # SentenceTransformer checkpoints carry config_sentence_transformers.json;
    # the loader expects it on disk. Copy if present, else emit a minimal stub.
    st_cfg_src = Path(tokenizer.name_or_path) / "config_sentence_transformers.json"
    st_cfg_dst = out_dir / "config_sentence_transformers.json"
    if st_cfg_src.exists():
        shutil.copyfile(str(st_cfg_src), str(st_cfg_dst))
    else:
        st_cfg_dst.write_text(
            json.dumps(
                {
                    "model_type": "sentence_transformers",
                    "modules": [
                        {"type": "Transformer", "kwargs": {}},
                        {"type": "Pooling", "kwargs": {"pooling_mode": "cls"}},
                    ],
                },
                indent=2,
            )
        )

    # Ensure a tokenizer_config.json exists (optimum may omit it).
    if not (out_dir / "tokenizer_config.json").exists() and (out_dir / "tokenizer.json").exists():
        (out_dir / "tokenizer_config.json").write_text(json.dumps({"model_type": "bert"}, indent=2))

    present = sorted(p.name for p in out_dir.rglob("*") if p.is_file())
    print(f"[export] wrote {len(present)} files to {out_dir}")
    print("[export] done. Select 'LightOn dense (mDenseOn)' in Settings -> Indexing.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", default=MODEL_ID, help="Source HF model (default: lightonai/mDenseOn)")
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Target dir (default: <userData>/codeindex/models/mDenseOn-onnx-int8)",
    )
    args = ap.parse_args()
    out = args.out or (default_models_root() / ARTIFACT_DIRNAME)
    export(args.model, out)


if __name__ == "__main__":
    main()
