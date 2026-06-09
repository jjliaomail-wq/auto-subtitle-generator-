import sys
import os
import datetime
import ssl
import opencc

# 全域忽略 SSL 憑證驗證，解決自簽憑證問題
ssl._create_default_https_context = ssl._create_unverified_context

import requests
_old_request = requests.Session.request
requests.Session.request = lambda self, *args, **kwargs: _old_request(self, *args, {**kwargs, 'verify': False})

import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

from faster_whisper import WhisperModel

def format_timestamp(seconds: float):
    td = datetime.timedelta(seconds=seconds)
    ms = int(td.microseconds / 1000)
    hours, remainder = divmod(td.seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02}:{minutes:02}:{seconds:02},{ms:03}"

def main():
    if len(sys.argv) < 3:
        print("Usage: python local_transcribe.py <audio_path> <output_srt_path>")
        sys.exit(1)
        
    audio_path = sys.argv[1]
    output_srt_path = sys.argv[2]
    
    if not os.path.exists(audio_path):
        print(f"Error: Audio path '{audio_path}' does not exist.")
        sys.exit(1)
        
    print(f"Loading Whisper Model (small)...")
    # 使用 cpu，以 int8 計算類型載入 small 模型
    model = WhisperModel("small", device="cpu", compute_type="int8")
    
    # 初始化 OpenCC 簡→繁轉換器
    converter = opencc.OpenCC('s2twp')  # 簡體轉繁體（台灣用語）
    
    print(f"Transcribing '{audio_path}'...")
    # beam_size=5 用於提高精確度
    segments, info = model.transcribe(audio_path, beam_size=5)
    print(f"Detected language '{info.language}' with probability {info.language_probability}")
    
    # 寫入標準 SRT（簡→繁轉換）
    with open(output_srt_path, "w", encoding="utf-8") as f:
        for i, segment in enumerate(segments, start=1):
            start = format_timestamp(segment.start)
            end = format_timestamp(segment.end)
            text = converter.convert(segment.text.strip())
            f.write(f"{i}\n{start} --> {end}\n{text}\n\n")
            
    print(f"Transcription finished. SRT saved to '{output_srt_path}'")

if __name__ == "__main__":
    main()
