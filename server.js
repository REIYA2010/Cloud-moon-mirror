
const express = require('express');
const fetch = require('node-fetch');
const https = require('https'); // 追加
const app = express();

// 1. あなたのWorker URLをここに入れる
const CF_WORKER_URLS = [
    "https://api-nemu.myproxy0108.workers.dev",
    "https://mangarw-api.72016.workers.dev"
];

let requestCount = 0;

// 【安定化の鍵】コネクションを閉じずに使い回す設定（Keep-Alive）
const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,      // 同時接続数を増やす
    maxFreeSockets: 10,
    timeout: 60000        // タイムアウトを1分に延長
});

app.use(express.raw({ type: '*/*', limit: '20mb' }));

app.all('*', async (req, res) => {
    try {
        const workerIndex = requestCount % CF_WORKER_URLS.length;
        const selectedWorker = CF_WORKER_URLS[workerIndex];
        requestCount++;

        const targetUrl = selectedWorker + req.url;

        const proxyHeaders = {};
        for (let [key, value] of Object.entries(req.headers)) {
            if (!['host', 'content-encoding', 'content-length', 'connection'].includes(key.toLowerCase())) {
                proxyHeaders[key] = value;
            }
        }

        proxyHeaders['X-Forwarded-Host'] = req.get('host');
        proxyHeaders['X-Forwarded-Proto'] = 'https';
        
        const fetchOptions = {
            method: req.method,
            headers: proxyHeaders,
            agent: proxyAgent, // 【重要】高速エージェントを適用
            redirect: 'follow',
            timeout: 15000     // 画像1枚に15秒以上かかったら次へ
        };

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            fetchOptions.body = req.body;
        }

        const response = await fetch(targetUrl, fetchOptions);

        // レスポンスヘッダーの設定
        response.headers.forEach((v, k) => {
            if (!['content-encoding', 'transfer-encoding', 'content-security-policy', 'x-frame-options'].includes(k.toLowerCase())) {
                res.set(k, v);
            }
        });
        
        // 画像のキャッシュをブラウザに指示（不安定さを解消）
        if (req.url.includes('.webp') || req.url.includes('.jpg') || req.url.includes('.png')) {
            res.set('Cache-Control', 'public, max-age=604800, immutable');
        }

        res.set("Access-Control-Allow-Origin", "*");

        const buffer = await response.buffer();
        res.status(response.status).send(buffer);

    } catch (error) {
        // タイムアウトや切断が起きてもサーバーを落とさない
        if (!res.headersSent) {
            res.status(504).send("Timeout or Connection Error");
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT);
