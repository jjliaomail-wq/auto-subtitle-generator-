// ------------------------------------------------------------
// generate_subtitles.js
// 依目錄內所有音訊檔產生中文 SRT、英文 SRT、以及英文→中文 SRT
// ------------------------------------------------------------
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // 忽略自簽憑證錯誤 (解決 Google Translate API 憑證問題)

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { globSync } from "glob";
import { execSync } from "node:child_process";
import { translate } from "@vitalets/google-translate-api";
import SrtParser from "srt-parser-2";

// 取得本檔案所在目錄
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- 設定 ----------
const AUDIO_GLOB = "*.{mp3,wav,m4a,flac,ogg,MP3,WAV,M4A,FLAC,OGG}"; // 支援大小寫副檔名

const parser = new SrtParser();

// Convert Simplified Chinese characters to Traditional (basic map)
function toTraditional(str) {
  const map = {
    '产': '產', '内': '內', '馆': '館', '测': '測', '经': '經', '听': '聽', '里': '裡',
    '过': '過', '后': '後', '为': '為', '简': '簡', '体': '體', '学': '學',
    '化': '化', '总': '總', '错': '錯', '灯': '燈',
    '从': '從', '神': '神', '经': '經', '科': '科', '学': '學', '产': '產', '内': '內', '馆': '館',
    '测': '測', '听': '聽', '里': '裡', '过': '過', '后': '後', '为': '為', '简': '簡', '体': '體'
  };
  return str.replace(/[产内馆测经听里过后为简体化总错灯从神经科产内馆测听里过后为简体]/g, ch => map[ch] || ch);
}

function timestampToSeconds(timestamp) {
  const match = timestamp.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) return 0;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const s = parseInt(match[3], 10);
  const ms = parseInt(match[4], 10);
  return h * 3600 + m * 60 + s + ms / 1000;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function transcribe(audioPath) {
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const tempSrtPath = path.join(path.dirname(audioPath), `${baseName}_temp_transcribe.srt`);

  console.log(`   🎙️ 啟動本地 Python faster-whisper 進行語音識別與自然斷句...`);
  const pythonScript = path.join(__dirname, "local_transcribe.py");
  const cmd = `python "${pythonScript}" "${audioPath}" "${tempSrtPath}"`;
  
  // 執行本地 python 轉寫
  execSync(cmd, { stdio: "inherit" });

  if (!(await fileExists(tempSrtPath))) {
    throw new Error("轉寫失敗，未產生臨時 SRT 字幕檔。");
  }

  // 讀取臨時 SRT 檔案內容
  const srtText = await fs.readFile(tempSrtPath, "utf8");

  // 刪除臨時檔案
  try {
    await fs.unlink(tempSrtPath);
    console.log("   🧹 已清理本地臨時 SRT 檔。");
  } catch (err) {
    console.warn("   ⚠️ 無法刪除本地臨時 SRT 檔：", err.message);
  }

  // 解析 SRT
  const parsed = parser.fromSrt(srtText);
  return parsed.map((item, i) => ({
    id: i + 1,
    startTime: timestampToSeconds(item.startTime),
    endTime: timestampToSeconds(item.endTime),
    text: toTraditional(item.text.trim()),
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
