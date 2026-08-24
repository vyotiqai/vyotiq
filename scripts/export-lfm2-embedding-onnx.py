#!/usr/bin/env python3
"""
Export LiquidAI/LFM2.5-Embedding-350M to a local ONNX the app can load.

The app's neural ONNX path (src/main/agent/codeindex) loads a *self-contained*
ONNX graph directly via ORT. LiquidAI publishes the embedding model as
safetensors + custom modeling code, but no ONNX for the embedding variant, so
we export it here once.

Requirements (not shipped with the app):
    pip install torch transformers sentence-transformers huggingface_hub onnx onnxruntime

The exported graph must expose:
    inputs : int64 `input_ids`, `attention_mask`
    output : `last_hidden_state` [batch, seq, hidden]  (CLS-pooled by the app)
and the directory must contain the tokenizer files the app reads.

Usage:
    python scripts/export-lfm2-embedding-onnx.py \
        --out "$APPDATA/vyotiq/codeindex/models/lfm2-embedding-onnx" \
        --quantize int8

The --out path MUST match the app's model dir:
    <userData>/codeindex/models/lfm2-embedding-onnx
where <userData> is Electron's userData (e.g. %APPDATA%/vyotiq on Windows,
~/Library/Application Support/vyotiq on macOS, ~/.config/vyotiq on Linux).
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

MODEL_ID = "LiquidAI/LFM2.5-Embedding-350M"
TOKENIZER_FILES = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "modules.json",
    "modeling_lfm2_bidirectional.py",
    "1_Pooling/config.json",
    "config_sentence_transformers.json",
    "sentence_bert_config.json",
]


def extract_last_hidden(out):
    """Pull the [batch,seq,hidden] tensor from a wide range of HF outputs."""
    if hasattr(out, "last_hidden_state") and out.last_hidden_state is not None:
        return out.last_hidden_state
    if isinstance(out, (tuple, list)):
        # Common: (last_hidden_state, pooler_output, ...) or hidden_states last
        if getattr(out, "hidden_states", None) is not None:
            return out.hidden_states[-1]
        return out[0]
    if isinstance(out, dict):
        for k in ("last_hidden_state", "hidden_states"):
            if k in out and out[k] is not None:
                v = out[k]
                return v[-1] if isinstance(v, (tuple, list)) else v
    raise RuntimeError(f"Could not locate last_hidden_state in model output: {type(out)}")


def export_onnx(model_dir: Path, quantize: str | None) -> None:
    import torch
    import torch.nn as nn
    from transformers import AutoModel, AutoTokenizer
    from huggingface_hub import snapshot_download

    print(f"[1/4] Downloading snapshot for {MODEL_ID} ...")
    snap = snapshot_download(MODEL_ID)

    print("[2/4] Loading base model with bidirectional patches (trust_remote_code) ...")
    hf_model = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True)
    hf_model.eval()
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)

    onnx_dir = model_dir / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = onnx_dir / "model_quantized.onnx"

    class EmbeddingWrapper(nn.Module):
        def __init__(self, model):
            super().__init__()
            self.model = model

        def forward(self, input_ids, attention_mask):
            out = self.model(input_ids=input_ids, attention_mask=attention_mask)
            return {"last_hidden_state": extract_last_hidden(out)}

    wrapper = EmbeddingWrapper(hf_model).eval()

    print(f"[3/4] Exporting ONNX -> {onnx_path} ...")
    dummy_ids = torch.zeros((1, 8), dtype=torch.long)
    dummy_mask = torch.ones((1, 8), dtype=torch.long)
    torch.onnx.export(
        wrapper,
        (dummy_ids, dummy_mask),
        str(onnx_path),
        input_names=["input_ids", "attention_mask"],
        output_names=["last_hidden_state"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq"},
            "attention_mask": {0: "batch", 1: "seq"},
            "last_hidden_state": {0: "batch", 1: "seq"},
        },
        opset_version=17,
        do_constant_folding=True,
    )

    if quantize == "int8":
        print("[3b] Dynamic int8 quantization (onnxruntime) ...")
        from onnxruntime.quantization import quantize_dynamic, QuantType

        qpath = model_dir / "onnx" / "model_quantized_q8.onnx"
        quantize_dynamic(str(onnx_path), str(qpath), weight_type=QuantType.QInt8)
        onnx_path.replace(onnx_path.with_suffix(".fp32.onnx"))
        qpath.replace(onnx_path)

    print("[4/4] Copying tokenizer/config files ...")
    for f in TOKENIZER_FILES:
        src = os.path.join(snap, f)
        if os.path.exists(src):
            dst = model_dir / f
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(src, dst)
        else:
            print(f"  (skip missing {f})")

    print(f"\nDone. Place/verify under: {model_dir}")
    print("The app will load it automatically once the 'lfm2' embedder is selected.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--out",
        default="lfm2-embedding-onnx",
        help="Output dir (default: ./lfm2-embedding-onnx). Point this at "
        "<userData>/codeindex/models/lfm2-embedding-onnx for the app to find it.",
    )
    parser.add_argument(
        "--quantize",
        choices=["int8", "none"],
        default="int8",
        help="Quantize weights to int8 (recommended) or leave fp32.",
    )
    args = parser.parse_args()

    model_dir = Path(args.out).expanduser().resolve()
    model_dir.mkdir(parents=True, exist_ok=True)

    try:
        export_onnx(model_dir, None if args.quantize == "none" else args.quantize)
    except ImportError as e:
        print(f"\nMissing dependency: {e}\nInstall: pip install torch transformers sentence-transformers huggingface_hub onnx onnxruntime", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as e:
        print(f"\nExport failed: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
