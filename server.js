import express from 'express';
import multer from 'multer';
import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// 設定檔案上傳暫存區
const upload = multer({ dest: 'uploads/' });

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="zh-TW">
        <head>
            <meta charset="UTF-8">
            <title>全自動雙語字幕生成器</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; background-color: #f5f5f5; }
                .container { background-color: white; padding: 2rem; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                h1 { color: #333; }
                button { background-color: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-size: 16px; margin-top: 10px;}
                button:hover { background-color: #0056b3; }
                input[type="file"] { margin-bottom: 15px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🎬 全自動雙語字幕生成器</h1>
                <p>上傳音訊或影片檔 (mp3/m4a/wav)，後台將使用 Whisper AI 進行轉寫並透過 Google 翻譯為雙語字幕。</p>
                <form action="/process" method="post" enctype="multipart/form-data">
                    <input type="file" name="audio" accept="audio/*,video/mp4" required /><br>
                    <button type="submit">開始生成 (需等候一段時間)</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

app.post('/process', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).send('沒有上傳檔案');
    
    // 取得原本副檔名
    const originalExt = path.extname(req.file.originalname) || '.mp3';
    // 改名加上副檔名，不然 FFmpeg 可能看不懂
    const filePath = req.file.path + originalExt;
    
    try {
        await fs.rename(req.file.path, filePath);
        
        console.log(`收到檔案，開始處理: ${filePath}`);
        
        // 呼叫你的命令列腳本
        exec(`node scripts/generate_subtitles.js "${filePath}"`, async (error, stdout, stderr) => {
            if (error) {
                console.error(error);
                return res.status(500).send(`<h2>處理失敗</h2><pre>${error.message}</pre><pre>${stdout}</pre>`);
            }
            
            // 你的腳本會在同一層產生 .srt 檔案
            const baseName = path.basename(filePath, originalExt);
            const dir = path.dirname(filePath);
            const srtPath = path.join(dir, `${baseName}.srt`);
            
            try {
                const srtContent = await fs.readFile(srtPath, 'utf8');
                res.send(`
                    <div style="font-family: sans-serif; padding: 2rem;">
                        <h2 style="color: green;">✅ 處理成功！</h2>
                        <a href="/">返回上一頁</a><br><br>
                        <textarea style="width:100%; height:500px; padding: 10px; font-family: monospace;">${srtContent}</textarea>
                    </div>
                `);
            } catch (e) {
                res.status(500).send(`<h2>找不到輸出的字幕檔</h2><pre>${stdout}</pre>`);
            }
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 啟動伺服器 (Hugging Face Spaces 預設要求 7860 Port)
const PORT = 7860;
app.listen(PORT, () => console.log(`伺服器已啟動，監聽 Port ${PORT}`));
