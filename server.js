
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

// コネクションプールを最適化
const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 200,      // 同時接続枠をさらに拡大
    maxFreeSockets: 50,
    scheduling: 'lifo',   // 最新のコネクションを優先使用
    timeout: 30000
});

app.all('*', async (req, res) => {
    const workerIndex = requestCount % CF_WORKER_URLS.length;
    const selectedWorker = CF_WORKER_URLS[workerIndex];
    requestCount++;

    const targetUrl = selectedWorker + req.url;

    const proxyHeaders = {};
    for (let [key, value] of Object.entries(req.headers)) {
        if (!['host', 'content-encoding', 'connection'].includes(key.toLowerCase())) {
            proxyHeaders[key] = value;
        }
    }
    proxyHeaders['X-Forwarded-Host'] = req.get('host');
    proxyHeaders['X-Forwarded-Proto'] = 'https';

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: proxyHeaders,
            agent: proxyAgent,
            compress: false, // 圧縮解除をWorker側に任せて、Renderは中継に徹する
            redirect: 'follow'
        });

        // ヘッダーの転送
        response.headers.forEach((v, k) => {
            if (!['content-encoding', 'transfer-encoding', 'content-security-policy'].includes(k.toLowerCase())) {
                res.set(k, v);
            }
        });

        // 強力なキャッシュ指示（画像の場合）
        if (req.url.includes('_proxy_') || /\.(webp|jpg|png|gif|css|js)$/.test(req.url)) {
            res.set('Cache-Control', 'public, max-age=31536000, stale-while-revalidate=86400');
        }

        res.status(response.status);

        // 【最速化のポイント】ストリーミング転送
        // response.buffer() を待たずに、届いたパケットをそのままresに流し込む
        response.body.pipe(res);

        // エラーハンドリング
        response.body.on('error', (err) => {
            console.error('Stream Error:', err);
            res.end();
        });

    } catch (error) {
        if (!res.headersSent) {
            res.status(502).send("Gateway Timeout");
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT);
