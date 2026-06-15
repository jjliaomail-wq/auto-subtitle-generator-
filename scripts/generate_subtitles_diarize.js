// ------------------------------------------------------------
// generate_subtitles_diarize.js
// 與 generate_subtitles.js 並行，額外產生帶 A:/B: 說話人前綴的 SRT
// 並支援雙語翻譯 (中翻英 / 英翻中)
//
// 環境變數：HF_TOKEN=hf_xxxxxxxx  (Hugging Face access token)
//   已寫入 .env，自動載入，無需手動 set
//
// 使用：node scripts/generate_subtitles_diarize.js [音訊檔1] [音訊檔2] ...
//       （拖曳音訊檔到 .bat 也可用）
// ------------------------------------------------------------
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // 忽略自簽憑證錯誤 (解決 Google Translate API 憑證問題)

import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

const __filenameTemp = fileURLToPath(import.meta.url);
const __dirnameTemp = path.dirname(__filenameTemp);
// 載入專案根目錄的 .env
config({ path: path.join(__dirnameTemp, "..", ".env") });
import { globSync } from "glob";
import { execSync } from "node:child_process";
import { translate } from "@vitalets/google-translate-api";
import SrtParser from "srt-parser-2";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUDIO_GLOB = "*.{mp3,wav,m4a,flac,ogg,MP3,WAV,M4A,FLAC,OGG}";
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
  return str.replace(/[产内馆测经听里过后为简体化总错灯从常神经科产内馆测听里過後為簡體]/g, ch => map[ch] || ch);
}

function formatVtt(parsedLines) {
  let vtt = "WEBVTT\n\n";
  parsedLines.forEach((l) => {
    const start = l.startTime.replace(',', '.');
    const end = l.endTime.replace(',', '.');
    vtt += `${start} --> ${end}\n${l.text}\n\n`;
  });
  return vtt;
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function translateDiarizedSrt(parsedLines, toLang) {
  // 提取說話人前綴 (例如 "A: ", "B: ")
  const processedLines = parsedLines.map(item => {
    const match = item.text.match(/^([A-H]:\s*)(.*)$/);
    if (match) {
      return { prefix: match[1], content: match[2] };
    }
    return { prefix: "", content: item.text };
  });

  // 合併文字進行翻譯
  const texts = processedLines.map(p => p.content).join('\n');
  const { text } = await translate(texts, { to: toLang });
  
  const translatedTexts = text.split('\n');
  return parsedLines.map((item, i) => {
    const prefix = processedLines[i].prefix;
    let translatedContent = translatedTexts[i] ?? processedLines[i].content;
    if (toLang === "zh-TW") {
      translatedContent = toTraditional(translatedContent);
    }
    return {
      ...item,
      text: `${prefix}${translatedContent}`,
    };
  });
}

async function diarizeTranscribe(audioPath) {
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const fileDir = path.dirname(audioPath);
  const outSrt = path.join(fileDir, `${baseName}_speakers.srt`);
  const outVtt = path.join(fileDir, `${baseName}_speakers.vtt`);

  const hfToken = process.env.HF_TOKEN ?? "";
  if (!hfToken) {
    console.error("❌ 未設定環境變數 HF_TOKEN！");
    console.error("   請先至 https://huggingface.co/pyannote/speaker-diarization-3.1 接受授權,");
    console.error("   產生 token 後設定: set HF_TOKEN=hf_xxx... (Windows) 或 export HF_TOKEN=hf_xxx...");
    process.exit(1);
  }

  const pythonScript = path.join(__dirname, "local_transcribe_diarize.py");
  const cmd = `python "${pythonScript}" "${audioPath}" "${outSrt}" "${hfToken}"`;

  console.log(`   🎙️  執行說話人辨識轉寫...`);
  execSync(cmd, { stdio: "inherit" });

  if (!(await fileExists(outSrt))) {
    throw new Error("說話人辨識失敗，未產生 SRT 檔。");
  }

  console.log(`   📄 產出原始說話人 SRT：${outSrt}`);

  // 讀取產出的說話人 SRT 檔案以進行翻譯
  const srtContent = await fs.readFile(outSrt, "utf8");
  const parsedLines = parser.fromSrt(srtContent);

  // 同步輸出原始說話人 VTT
  const srtVttContent = formatVtt(parsedLines);
  await fs.writeFile(outVtt, srtVttContent, "utf8");
  console.log(`   📄 產出原始說話人 VTT：${outVtt}`);

  // 判斷語言（有無中文）以決定翻譯方向
  const containsChinese = parsedLines.some(l => /[\u4e00-\u9fff]/.test(l.text));
  const sourceLang = containsChinese ? "zh" : "en";
  const targetLang = sourceLang === "zh" ? "en" : "zh-TW";

  console.log(`   🔤 偵測到主要語言為 ${sourceLang}，開始翻譯說話人字幕為 ${targetLang}...`);
  try {
    const translatedLines = await translateDiarizedSrt(parsedLines, targetLang);
    const translatedSrtContent = parser.toSrt(translatedLines);
    const translatedVttContent = formatVtt(translatedLines);

    const transSrtPath = path.join(fileDir, `${baseName}_speakers_${targetLang}.srt`);
    const transVttPath = path.join(fileDir, `${baseName}_speakers_${targetLang}.vtt`);

    await fs.writeFile(transSrtPath, translatedSrtContent, "utf8");
    await fs.writeFile(transVttPath, translatedVttContent, "utf8");

    if (targetLang === "zh-TW") {
      try {
        console.log(`   ✨ 進行 OpenCC (s2twp) 繁體化與台灣用語精確轉換...`);
        execSync(`python -c "import opencc; conv = opencc.OpenCC('s2twp'); f = open(r'${transSrtPath}', 'r', encoding='utf-8'); c = f.read(); f.close(); open(r'${transSrtPath}', 'w', encoding='utf-8').write(conv.convert(c))"`);
        execSync(`python -c "import opencc; conv = opencc.OpenCC('s2twp'); f = open(r'${transVttPath}', 'r', encoding='utf-8'); c = f.read(); f.close(); open(r'${transVttPath}', 'w', encoding='utf-8').write(conv.convert(c))"`);
      } catch (ccErr) {
        console.warn(`   ⚠️ OpenCC 轉換失敗（使用 JS 內建基本繁體化）：${ccErr.message}`);
      }
    }

    console.log(`   📄 產出翻譯說話人 SRT：${transSrtPath}`);
    console.log(`   📄 產出翻譯說話人 VTT：${transVttPath}`);
  } catch (transErr) {
    console.error(`   ❌ 說話人字幕翻譯失敗: ${transErr.message}`);
  }

  return outSrt;
}

// ---------- 主流程 ----------
(async () => {
  try {
    const args = process.argv.slice(2);
    const audioFiles =
      args.length > 0
        ? args.map((a) => path.resolve(a))
        : globSync(AUDIO_GLOB, { cwd: __dirname, absolute: true, nodir: true });

    if (audioFiles.length === 0) {
      console.log("📂 找不到音訊檔案。");
      return;
    }

    console.log(`🔊 共 ${audioFiles.length} 個音訊檔案，開始說話人辨識與雙語翻譯流程...`);

    for (const audioPath of audioFiles) {
      const ext = path.extname(audioPath);
      const baseName = path.basename(audioPath, ext);
      console.log(`▶️  處理 ${baseName}${ext}`);
      await diarizeTranscribe(audioPath);
    }

    console.log("✅ 所有說話人與雙語翻譯字幕已產生！");
    process.exit(0);
  } catch (err) {
    console.error("❌ 執行失敗:", err);
    process.exit(1);
  }
})();
