const express = require('express');
const fetch = require('node-fetch'); // ライブラリを明示的に読み込み
const app = express();

const CF_WORKER_URL = "https://manga-api.myproxy0108.workers.dev/";

app.all('*', async (req, res) => {
    try {
        const targetUrl = CF_WORKER_URL + req.url;

        const response = await fetch(targetUrl, {
            method: req.method,
            headers: {
                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': req.headers['accept'] || '*/*',
                'Accept-Language': req.headers['accept-language'] || 'ja,en-US;q=0.9',
                'Cookie': req.headers['cookie'] || ''
            },
            timeout: 30000 // 30秒まで待機（漫画サイト対策）
        });

        // Workersからのレスポンスヘッダーをコピー
        response.headers.forEach((v, k) => {
            if (!['content-encoding', 'transfer-encoding'].includes(k.toLowerCase())) {
                res.set(k, v);
            }
        });

        const buffer = await response.buffer();
        res.status(response.status).send(buffer);

    } catch (error) {
        console.error("Critical Error:", error);
        res.status(500).send("読み込みに失敗しました: " + error.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
