FROM node:18-bullseye-slim

WORKDIR /app

# 安裝 ffmpeg (Whisper 必須)
RUN apt-get update && apt-get install -y ffmpeg

COPY package*.json ./
RUN npm install

COPY . .

# 建立上傳資料夾
RUN mkdir -p uploads

# Hugging Face 預設使用 7860 port
EXPOSE 7860

CMD ["node", "server.js"]
