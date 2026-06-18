const express = require('express');
const fetch = require('node-fetch');
const app = express();

// 1. あなたのWorker URLをここに入れる
const CF_WORKER_URLS = [
    "https://api-nemu.myproxy0108.workers.dev",
    "https://mangarw-api.72016.workers.dev"
];

let requestCount = 0;

// ボディ解析を制限（プロキシとして動かすため、勝手にJSON解析させない）
app.use(express.raw({ type: '*/*', limit: '20mb' }));

app.all('*', async (req, res) => {
    try {
        // 2. Workerの選択（ラウンドロビン）
        const workerIndex = requestCount % CF_WORKER_URLS.length;
        const selectedWorker = CF_WORKER_URLS[workerIndex];
        requestCount++;

        const targetUrl = selectedWorker + req.url;

        // 3. リクエストヘッダーの構築
        const proxyHeaders = {};
        for (let [key, value] of Object.entries(req.headers)) {
            // ホストやエンコーディングなど、不具合の元になるヘッダーを除外
            if (!['host', 'content-encoding', 'content-length', 'connection'].includes(key.toLowerCase())) {
                proxyHeaders[key] = value;
            }
        }

        // 重要：WorkerにRenderのドメインを教える
        proxyHeaders['X-Forwarded-Host'] = req.get('host');
        proxyHeaders['X-Forwarded-Proto'] = 'https';
        
        // 4. Workerへアクセス
        const fetchOptions = {
            method: req.method,
            headers: proxyHeaders,
            redirect: 'follow',
            timeout: 30000
        };

        // GET/HEAD以外ならBodyを付ける
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            fetchOptions.body = req.body;
        }

        const response = await fetch(targetUrl, fetchOptions);

        // 5. レスポンスヘッダーの引き継ぎ
        response.headers.forEach((v, k) => {
            // 二重圧縮やセキュリティ制限を回避
            if (!['content-encoding', 'transfer-encoding', 'content-security-policy', 'x-frame-options'].includes(k.toLowerCase())) {
                res.set(k, v);
            }
        });
        
        res.set("Access-Control-Allow-Origin", "*");

        // 6. データの返却（バイナリ対応）
        const buffer = await response.buffer();
        res.status(response.status).send(buffer);

    } catch (error) {
        console.error(`Render Proxy Error: ${error.message}`);
        res.status(502).send(`Render側での接続エラー: ${error.message}`);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Stable proxy running on port ${PORT}`);
});
