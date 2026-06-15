"""
local_transcribe_diarize.py
用 faster-whisper 轉寫 + pyannote.audio 說話人辨識
輸出帶 A: / B: 前綴的 SRT

使用方式:
  python local_transcribe_diarize.py <audio_path> <output_srt_path> [HF_TOKEN]

HF_TOKEN 也可改用環境變數 HF_TOKEN 傳入。
"""

import sys
import os
import datetime
import ssl

# 全域忽略 SSL 憑證驗證
ssl._create_default_https_context = ssl._create_unverified_context

import requests
_old_request = requests.Session.request
requests.Session.request = lambda self, *args, **kwargs: _old_request(self, *args, **{**kwargs, 'verify': False})

import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

import opencc
from faster_whisper import WhisperModel


def format_timestamp(seconds: float) -> str:
    td = datetime.timedelta(seconds=seconds)
    ms = int(td.microseconds / 1000)
    hours, remainder = divmod(int(td.seconds), 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02}:{minutes:02}:{secs:02},{ms:03}"


def load_waveform(audio_path: str) -> dict:
    """
    用 PyAV 解碼音訊，回傳 pyannote 接受的 in-memory dict：
      {'waveform': (1, T) float32 tensor, 'sample_rate': 16000}
    完全繞過 torchcodec / AudioDecoder。
    """
    import av
    import torch
    import numpy as np

    SAMPLE_RATE = 16000
    container = av.open(audio_path)
    audio_stream = next(s for s in container.streams if s.type == "audio")
    resampler = av.AudioResampler(format="flt", layout="mono", rate=SAMPLE_RATE)

    chunks = []
    for frame in container.decode(audio_stream):
        for r in resampler.resample(frame):
            chunks.append(r.to_ndarray()[0])
    container.close()

    # flush resampler
    for r in resampler.resample(None):
        chunks.append(r.to_ndarray()[0])

    waveform = np.concatenate(chunks) if chunks else np.array([], dtype=np.float32)
    tensor = torch.from_numpy(waveform).unsqueeze(0)  # shape: (1, T)
    return {"waveform": tensor, "sample_rate": SAMPLE_RATE}


def get_speaker_turns(audio_path: str, hf_token: str):
    """
    呼叫 pyannote.audio 3.1 做說話人辨識，
    回傳 list of (start_sec, end_sec, speaker_label)
    """
    try:
        from pyannote.audio import Pipeline
        import torch
    except ImportError:
        print("⚠️  找不到 pyannote.audio，請先安裝：pip install pyannote.audio")
        return None

    print("📡 載入 pyannote speaker-diarization-3.1 模型...")
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        token=hf_token,
    )

    try:
        import torch
        if torch.cuda.is_available():
            pipeline = pipeline.to(torch.device("cuda"))
    except Exception:
        pass

    # 用 PyAV 讀入記憶體，完全繞過 torchcodec / AudioDecoder
    print("🔄 用 PyAV 載入音訊（繞過 torchcodec）...")
    audio_dict = load_waveform(audio_path)

    print(f"🔍 說話人辨識中（CPU 需要幾分鐘，請稍候）...")
    result = pipeline(audio_dict)

    # pyannote 4.x 回傳 DiarizeOutput dataclass，需取 .speaker_diarization
    if hasattr(result, 'speaker_diarization'):
        annotation = result.speaker_diarization
    elif hasattr(result, 'diarization'):
        annotation = result.diarization
    elif hasattr(result, 'itertracks'):
        annotation = result
    elif isinstance(result, dict) and 'speaker_diarization' in result:
        annotation = result['speaker_diarization']
    elif isinstance(result, dict) and 'diarization' in result:
        annotation = result['diarization']
    else:
        annotation = result

    turns = []
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        turns.append((turn.start, turn.end, speaker))
    return turns


def assign_speaker(start: float, end: float, turns) -> str:
    """找出與 whisper segment 重疊最多的說話人 turn"""
    if not turns:
        return ""

    best_overlap = 0.0
    best_speaker = turns[0][2]

    for (t_start, t_end, speaker) in turns:
        overlap = max(0, min(end, t_end) - max(start, t_start))
        if overlap > best_overlap:
            best_overlap = overlap
            best_speaker = speaker

    return best_speaker


def build_speaker_map(turns):
    """依出現順序把 speaker label 映射為 A、B、C..."""
    mapping = {}
    letters = "ABCDEFGH"
    for (_, _, spk) in turns:
        if spk not in mapping:
            mapping[spk] = letters[len(mapping)]
    return mapping


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

    if len(sys.argv) < 3:
        print("Usage: python local_transcribe_diarize.py <audio_path> <output_srt_path> [HF_TOKEN]")
        sys.exit(1)

    audio_path = sys.argv[1]
    output_srt_path = sys.argv[2]
    hf_token = sys.argv[3] if len(sys.argv) >= 4 else os.environ.get("HF_TOKEN", "")

    if not os.path.exists(audio_path):
        print(f"Error: '{audio_path}' does not exist.")
        sys.exit(1)

    if not hf_token:
        print("❌ 未提供 HF_TOKEN！")
        sys.exit(1)

    # ── 1. 說話人辨識 ──────────────────────────────────────
    turns = get_speaker_turns(audio_path, hf_token)
    if turns is None:
        sys.exit(1)

    speaker_map = build_speaker_map(turns)
    print(f"👥 偵測到 {len(speaker_map)} 位說話人：{speaker_map}")

    # ── 2. Whisper 轉寫 ────────────────────────────────────
    print("🎙️  載入 Whisper small 模型...")
    model = WhisperModel("small", device="cpu", compute_type="int8")
    converter = opencc.OpenCC('s2twp')

    print(f"📝 轉寫中：{audio_path}")
    segments, info = model.transcribe(audio_path, beam_size=5)
    print(f"   偵測語言：{info.language}（機率 {info.language_probability:.2f}）")

    # ── 3. 對齊說話人 & 寫出 SRT ──────────────────────────
    with open(output_srt_path, "w", encoding="utf-8") as f:
        for i, seg in enumerate(segments, start=1):
            raw_speaker = assign_speaker(seg.start, seg.end, turns)
            label = speaker_map.get(raw_speaker, "A")
            text = converter.convert(seg.text.strip())
            start_ts = format_timestamp(seg.start)
            end_ts = format_timestamp(seg.end)
            f.write(f"{i}\n{start_ts} --> {end_ts}\n{label}: {text}\n\n")

    print(f"✅ 帶說話人標籤的 SRT 已儲存：{output_srt_path}")


if __name__ == "__main__":
    main()
