
const express = require('express');
const fetch = require('node-fetch');
const https = require('https'); // 追加
const app = express();

// 1. あなたのWorker URLをここに入れる
const CF_WORKER_URLS = [
    "https://api-mangarw.myproxy0108.workers.dev",
    "https://mangarw-api.72016.workers.dev"
];

let requestCount = 0;

const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 200,
    timeout: 30000
});

app.all('*', async (req, res) => {
    const workerIndex = requestCount % CF_WORKER_URLS.length;
    const selectedWorker = CF_WORKER_URLS[workerIndex];
    requestCount++;

    const targetUrl = selectedWorker + req.url;

    const proxyHeaders = {};
    for (let [key, value] of Object.entries(req.headers)) {
        // hostとaccept-encodingをあえて消し、node-fetchに制御を任せる
        if (!['host', 'connection', 'accept-encoding'].includes(key.toLowerCase())) {
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
            compress: true, // 【重要】ここでnode-fetchに自動解凍させる（文字化け防止）
            redirect: 'follow'
        });

        // ブラウザへ返すヘッダーの整理
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            // 以下のヘッダーはRender側で新しく生成・制御するため、コピーしない
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options'].includes(key)) {
                res.set(k, v);
            }
        });

        // 文字化け対策：Content-Typeにcharset=utf-8を強制付与（HTMLの場合）
        let contentType = response.headers.get("content-type") || "";
        if (contentType.includes("text/html") && !contentType.includes("charset")) {
            res.set("Content-Type", contentType + "; charset=utf-8");
        }

        // キャッシュ制御
        if (req.url.includes('_proxy_') || /\.(webp|jpg|png|gif|css|js)$/.test(req.url)) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
        }

        res.status(response.status);

        // ストリーミング転送
        // node-fetchが解凍した生のデータを、そのままブラウザに流し込む
        response.body.pipe(res);

        response.body.on('error', (err) => {
            console.error('Stream Error:', err);
            if (!res.headersSent) res.end();
        });

    } catch (error) {
        console.error('Proxy Fatal Error:', error);
        if (!res.headersSent) {
            res.status(502).send("Proxy error occurred.");
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Streaming Proxy running..."));
