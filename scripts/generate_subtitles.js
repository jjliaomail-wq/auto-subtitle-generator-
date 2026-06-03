// ------------------------------------------------------------
// generate_subtitles.js
// 依目錄內所有音訊檔產生中文 SRT、英文 SRT、以及英文→中文 SRT
// ------------------------------------------------------------
process.env.ORT_LOG_SEVERITY_LEVEL = '3'; // 隱藏 ONNX 煩人的警告訊息
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // 忽略自簽憑證錯誤 (解決 Google Translate API 憑證問題)

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { globSync } from "glob";
import { pipeline } from "@xenova/transformers";
import { translate } from "@vitalets/google-translate-api";
import SrtParser from "srt-parser-2";

// 取得本檔案所在目錄
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- 設定 ----------
const AUDIO_GLOB = "*.{mp3,wav,m4a,flac,ogg,MP3,WAV,M4A,FLAC,OGG}"; // 支援大小寫副檔名
const MODEL = "tiny"; // 可改為 base/medium 依需求

import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const parser = new SrtParser();

// Helper: load audio using ffmpeg to Float32Array (16kHz mono)
// Helper: load audio using ffmpeg to Float32Array (16kHz mono)
async function loadAudio(filePath) {
  // 使用 ffmpeg 以串流方式讀取 PCM，避免一次性載入大檔案造成緩衝限制
  return new Promise((resolve, reject) => {
    const args = [
      "-i", filePath,
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ar", "16000",
      "-ac", "1",
      "-",
    ];
    const ff = spawn(ffmpegPath, args);
    const chunks = [];
    ff.stdout.on("data", (data) => chunks.push(data));
    ff.stderr.on("data", () => {}); // ignore stderr output
    ff.on("error", (err) => reject(err));
    ff.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited with code ${code}`));
      }
      const buffer = Buffer.concat(chunks);
      // Convert Int16 PCM to Float32 normalized [-1, 1]
      const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }
      resolve(float32);
    });
  });
}

// Split a long Whisper segment into shorter pieces based on sentence boundaries.
function splitLongSegment(segment) {
  const text = segment.text.trim();
  // Split by punctuation followed by whitespace.
  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length <= 1) {
    // Fallback: split into roughly equal chunks of 100 characters.
    const maxLen = 100;
    const chunks = [];
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.slice(i, i + maxLen));
    }
    return generateSubsegments(segment.start, segment.end, chunks);
  }
  return generateSubsegments(segment.start, segment.end, sentences);
}

function generateSubsegments(start, end, parts) {
  const totalDuration = end - start;
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const subsegments = [];
  let curStart = start;
  for (const part of parts) {
    const proportion = part.length / totalLength;
    const segDuration = totalDuration * proportion;
    const segEnd = curStart + segDuration;
    subsegments.push({
      start: curStart,
      end: segEnd,
      text: part.trim(),
    });
    curStart = segEnd;
  }
  return subsegments;
}

async function transcribe(audioPath) {
  // 使用 transformers pipeline 進行 Whisper 轉寫，針對長音檔使用 chunk 參數
  const transcriber = await pipeline("automatic-speech-recognition", `Xenova/whisper-${MODEL}`);
  const audioArray = await loadAudio(audioPath);
  const durationSec = audioArray.length / 16000;
  const options = durationSec > 30 ? { chunk_length_s: 30, stride_length_s: 5 } : {};
  const result = await transcriber(audioArray, options);
  const rawSegments = result.segments || [{
    start: 0,
    end: result.duration || 0,
    text: result.text,
  }];
  // If Whisper returns a single segment with zero duration, fallback to full audio length
  if (rawSegments.length === 1 && rawSegments[0].start === rawSegments[0].end) {
    rawSegments[0].end = durationSec;
  }
  // Split any segment longer than MAX_DURATION seconds into shorter pieces based on sentences
  const MAX_DURATION = 4; // seconds per subtitle line
  const splitLong = (segment) => {
    const segDuration = segment.end - segment.start;
    if (segDuration <= MAX_DURATION && segment.text.length <= 120) {
      return [segment];
    }
    return splitLongSegment(segment);
  };
  const processedSegments = rawSegments.flatMap(splitLong);
  // Ensure no segment exceeds MAX_DURATION seconds by further splitting if needed
  const enforceMax = (segment) => {
    const segDuration = segment.end - segment.start;
    if (segDuration <= MAX_DURATION) return [segment];
    // Split by approximate character count proportionally
    const avgCharPerSec = segment.text.length / segDuration;
    const targetCharCount = Math.round(avgCharPerSec * MAX_DURATION);
    const chunks = [];
    for (let i = 0; i < segment.text.length; i += targetCharCount) {
      const part = segment.text.slice(i, i + targetCharCount).trim();
      const partDuration = part.length / avgCharPerSec;
      const start = i === 0 ? segment.start : chunks[chunks.length - 1].end;
      const end = start + partDuration;
      chunks.push({ start, end, text: part });
    }
    return chunks;
  };
  const finalSegments = processedSegments.flatMap(enforceMax);
  return finalSegments.map((seg, i) => ({
    id: i + 1,
    startTime: seg.start,
    endTime: seg.end,
    text: seg.text.trim(),
  }));
}

function formatSrt(lines) {
  return parser.toSrt(
    lines.map((l) => ({
      id: l.id,
      startTime: secondsToTimestamp(l.startTime),
      endTime: secondsToTimestamp(l.endTime),
      text: l.text,
    }))
  );
}

function formatVtt(lines) {
  let vtt = "WEBVTT\n\n";
  lines.forEach((l) => {
    const start = secondsToTimestamp(l.startTime).replace(',', '.');
    const end = secondsToTimestamp(l.endTime).replace(',', '.');
    vtt += `${start} --> ${end}\n${l.text}\n\n`;
  });
  return vtt;
}

function secondsToTimestamp(sec) {
  const h = Math.floor(sec / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((sec % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(sec % 60)
    .toString()
    .padStart(2, "0");
  const ms = Math.round((sec - Math.floor(sec)) * 1000)
    .toString()
    .padStart(3, "0");
  return `${h}:${m}:${s},${ms}`;
}

async function translateSrt(lines, toLang) {
  const texts = lines.map(l => l.text).join('\n');
  const { text } = await translate(texts, { to: toLang });
  const translated = text.split('\n');
  return lines.map((l, i) => ({
    ...l,
    text: translated[i] ?? l.text,
  }));
}

// ---------- 主流程 ----------
(async () => {
  try {
    const args = process.argv.slice(2);
    // 如果傳入檔名(支援拖曳多個檔案)，直接處理；否則使用 glob 取得目錄內全部音訊檔
    const audioFiles = args.length > 0 
      ? args.map(arg => path.resolve(arg)) 
      : globSync(AUDIO_GLOB, {
          cwd: __dirname,
          absolute: true,
          nodir: true,
        });

    if (audioFiles.length === 0) {
      console.log("📂 找不到音訊檔案，請確認目錄與副檔名。");
      return;
    }

    console.log(`🔊 共 ${audioFiles.length} 個音訊檔案，開始處理...`);

    for (const audioPath of audioFiles) {
      const baseName = path.basename(audioPath, path.extname(audioPath));
      console.log(`▶️ 處理 ${baseName}${path.extname(audioPath)}`);

      // 1️⃣ 轉寫取得原始字幕 (自動偵測語言)
      const transcribedLines = await transcribe(audioPath);
      // 判斷語系（簡易檢測是否包含中文字符）
      const containsChinese = transcribedLines.some(l => /[\u4e00-\u9fff]/.test(l.text));
      const sourceLang = containsChinese ? "zh" : "en";
      
      // 產生原始語系字幕檔 (SRT & VTT)
      const sourceSrt = formatSrt(transcribedLines);
      const sourceVtt = formatVtt(transcribedLines);
      
      // 輸出到與音訊檔相同的目錄，檔名相同
      const fileDir = path.dirname(audioPath);
      const srtPath = path.join(fileDir, `${baseName}.srt`);
      const vttPath = path.join(fileDir, `${baseName}.vtt`);
      
      await fs.writeFile(srtPath, sourceSrt, "utf8");
      await fs.writeFile(vttPath, sourceVtt, "utf8");
      
      console.log(`   📄 產出原始 SRT：${srtPath}`);
      console.log(`   📄 產出原始 VTT：${vttPath}`);

      // 2️⃣ 翻譯字幕
      const targetLang = sourceLang === "zh" ? "en" : "zh-TW";
      console.log(`   🔤 偵測到主要語言為 ${sourceLang}，開始翻譯為 ${targetLang}...`);
      try {
        const translatedLines = await translateSrt(transcribedLines, targetLang);
        const translatedSrt = formatSrt(translatedLines);
        const translatedVtt = formatVtt(translatedLines);
        
        const transSrtPath = path.join(fileDir, `${baseName}_${targetLang}.srt`);
        const transVttPath = path.join(fileDir, `${baseName}_${targetLang}.vtt`);
        
        await fs.writeFile(transSrtPath, translatedSrt, "utf8");
        await fs.writeFile(transVttPath, translatedVtt, "utf8");
        
        console.log(`   📄 產出翻譯 SRT：${transSrtPath}`);
        console.log(`   📄 產出翻譯 VTT：${transVttPath}`);
      } catch (transErr) {
        console.error(`   ❌ 翻譯失敗: ${transErr.message}`);
      }
    }

    console.log("✅ 所有字幕檔案已產生完畢！");
    // 強制結束程式，避免 ONNX 警告持續輸出
    process.exit(0);
  } catch (err) {
    console.error("❌ 執行失敗:", err);
  }
})();
