const express = require('express');
const app = express();

// Renderは自動的にポート番号を process.env.PORT に割り当てます
const PORT = process.env.PORT || 3000;

// あなたのCloudflare WorkersのURL
const WORKER_URL = "https://sika-sika-manga.myproxy0108.workers.dev/";

// ① トップページ (RenderのURLにアクセスした時に表示される)
app.get('/', (req, res) => {
  res.send(`
    <h1>Renderのアプリが稼働中！</h1>
    <p>Cloudflare Workersとの連携システムが立ち上がりました。</p>
    <a href="/api/fetch-data">Workers経由でデータを取得するテスト</a>
  `);
});

// ② Cloudflare Workers（プロキシ）を糧にして外部のデータを取得するAPI
app.get('/api/fetch-data', async (req, res) => {
  try {
    // 例：取得したい外部サイトのURL（スクレイピング先や画像APIなど）
    const targetUrl = "https://jsonplaceholder.typicode.com/todos/1"; 

    // Renderから、Cloudflare Workers宛にリクエストを投げる
    // ※Worker側で "?url=..." のように受け取る設計を想定しています
    const response = await fetch(`${WORKER_URL}?url=${encodeURIComponent(targetUrl)}`);
    
    if (!response.ok) {
      throw new Error(`Worker returned status: ${response.status}`);
    }

    const data = await response.json(); // または .text() や .arrayBuffer()

    // 取得したデータをユーザー（ブラウザ）に返す
    res.json({
      message: "Cloudflare Workers経由でデータの取得に成功しました！",
      worker_used: WORKER_URL,
      result: data
    });

  } catch (error) {
    console.error("Error fetching via Worker:", error);
    res.status(500).json({ error: "Workers経由でのデータ取得に失敗しました" });
  }
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
