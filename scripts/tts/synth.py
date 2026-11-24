# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "kokoro>=0.9.4",
#   "misaki[en]>=0.9.4",
#   "en-core-web-sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl",
#   "lameenc>=1.7",
#   "numpy",
#   "torch>=2.6",
# ]
#
# # CPU build of torch: ~1 GB instead of ~5 GB for CUDA, and Kokoro's output
# # is identical either way, only slower. For an NVIDIA GPU, point both lines
# # at https://download.pytorch.org/whl/cu128 instead.
# [tool.uv.sources]
# torch = [{ index = "pytorch-cpu", marker = "sys_platform != 'darwin'" }]
#
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# ///
"""
Kokoro TTS worker for scripts/tts/generate.mjs.

Reads a job file written by the Node side (the text has already been
extracted from the post and split into chunks), synthesises every chunk with
Kokoro, joins them with the requested pauses, levels the result, and encodes
a mono MP3. Prints one JSON line on stdout with the duration and size;
progress goes to stderr.

    uv run scripts/tts/synth.py job.json
    uv run scripts/tts/synth.py job.json --phonemes   # print G2P output, no audio

Not meant to be run by hand outside of debugging -- `pnpm tts` drives it.
"""

import json
import sys
import time
import warnings
from pathlib import Path

import numpy as np

SAMPLE_RATE = 24_000  # Kokoro's native output rate
REPO_ID = "hexgrad/Kokoro-82M"

# Level speech to roughly -18 dBFS RMS, never letting a peak past -1 dBFS.
TARGET_RMS = 10 ** (-18 / 20)
PEAK_CEILING = 10 ** (-1 / 20)


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def load_pipeline(lang: str):
    # Kokoro and its deps are chatty about things we do not control.
    warnings.filterwarnings("ignore")
    import torch
    from kokoro import KPipeline

    device = "cuda" if torch.cuda.is_available() else "cpu"
    log(f"kokoro: loading on {device}")
    return KPipeline(lang_code=lang, repo_id=REPO_ID, device=device)


def level(audio: np.ndarray) -> np.ndarray:
    voiced = audio[np.abs(audio) > 1e-3]
    if voiced.size == 0:
        return audio
    rms = float(np.sqrt(np.mean(voiced**2)))
    peak = float(np.max(np.abs(audio)))
    gain = min(TARGET_RMS / rms, PEAK_CEILING / peak)
    return audio * gain


def encode_mp3(audio: np.ndarray, bitrate: int) -> bytes:
    import lameenc

    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    enc = lameenc.Encoder()
    enc.set_in_sample_rate(SAMPLE_RATE)
    enc.set_channels(1)
    enc.set_bit_rate(bitrate)
    enc.set_quality(2)  # 2 = high quality, slow; 7 = fast
    return bytes(enc.encode(pcm) + enc.flush())


def main() -> int:
    args = sys.argv[1:]
    if not args:
        log(__doc__)
        return 2
    sys.stdout.reconfigure(encoding="utf-8")  # IPA on a Windows console
    job = json.loads(Path(args[0]).read_text(encoding="utf-8"))
    pipeline = load_pipeline(job["lang"])

    if "--phonemes" in args:
        for chunk in job["chunks"]:
            phonemes, _ = pipeline.g2p(chunk["text"])
            print(json.dumps({"text": chunk["text"], "phonemes": phonemes}, ensure_ascii=False))
        return 0

    parts: list[np.ndarray] = []
    started = time.monotonic()
    total = len(job["chunks"])
    for i, chunk in enumerate(job["chunks"], 1):
        for result in pipeline(
            chunk["text"], voice=job["voice"], speed=job["speed"], split_pattern=None
        ):
            if result.audio is not None:
                parts.append(result.audio.detach().cpu().numpy().astype(np.float32))
        pause = int(SAMPLE_RATE * chunk["pause"] / 1000)
        if pause:
            parts.append(np.zeros(pause, dtype=np.float32))
        if i % 25 == 0 or i == total:
            log(f"kokoro: {i}/{total} chunks ({time.monotonic() - started:.0f}s)")

    audio = level(np.concatenate(parts))
    mp3 = encode_mp3(audio, job["bitrate"])
    out = Path(job["out"])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(mp3)

    print(json.dumps({"duration": round(audio.size / SAMPLE_RATE, 2), "bytes": len(mp3)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
