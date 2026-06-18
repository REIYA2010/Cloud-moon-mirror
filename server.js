const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const app = express();

const CF_WORKER_URLS = [
    "https://api-nemu.myproxy0108.workers.dev",
    "https://mangarw-api.72016.workers.dev"
];

let requestCount = 0;

// 【高速化設定】コネクションプールの最大化
const proxyAgent = new https.Agent({
    keepAlive: true,      // 接続を維持
    maxSockets: 256,      // 同時リクエスト枠を大幅増加
    maxFreeSockets: 64,
    timeout: 60000,
    scheduling: 'lifo'    // 新しいリクエストを優先
});

app.all('*', async (req, res) => {
    const selectedWorker = CF_WORKER_URLS[requestCount++ % CF_WORKER_URLS.length];
    
    // 不要なヘッダーを削り、転送を軽くする
    const cleanHeaders = {};
    for (let key in req.headers) {
        if (!['host', 'connection', 'content-length'].includes(key.toLowerCase())) {
            cleanHeaders[key] = req.headers[key];
        }
    }
    cleanHeaders['X-Forwarded-Host'] = req.get('host');
    cleanHeaders['X-Forwarded-Proto'] = 'https';

    try {
        const response = await fetch(selectedWorker + req.url, {
            method: req.method,
            headers: cleanHeaders,
            agent: proxyAgent,
            compress: true, // 解凍して流す
            redirect: 'follow'
        });

        // ヘッダーの整理
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy'].includes(key)) {
                res.set(k, v);
            }
        });

        // ブラウザキャッシュを強力に効かせる
        if (req.url.includes('_p_')) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
        }

        res.status(response.status);
        
        // ストリーミングで即座に流す
        response.body.pipe(res);

        response.body.on('error', () => res.end());

    } catch (error) {
        if (!res.headersSent) res.status(502).end();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT);
