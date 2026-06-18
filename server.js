const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const app = express();

const CF_WORKER_URLS = [
    "https://api-nemu.myproxy0108.workers.dev",
    "https://mangarw-api.72016.workers.dev"
];

let requestCount = 0;

const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 256,
    timeout: 60000
});

app.use(express.raw({ type: '*/*', limit: '50mb' }));

app.all('*', async (req, res) => {
    const selectedWorker = CF_WORKER_URLS[requestCount++ % CF_WORKER_URLS.length];
    const targetUrl = selectedWorker + req.url;

    const cleanHeaders = {};
    const skip = ['host', 'connection', 'content-length', 'content-encoding', 'cf-ray', 'cf-connecting-ip', 'x-real-ip'];
    for (let key in req.headers) {
        if (!skip.includes(key.toLowerCase())) cleanHeaders[key] = req.headers[key];
    }
    cleanHeaders['X-Forwarded-Host'] = req.get('host');
    cleanHeaders['X-Forwarded-Proto'] = 'https';

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: cleanHeaders,
            agent: proxyAgent,
            compress: true, // Render側で解凍する
            redirect: 'follow',
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined
        });

        // --- ヘッダーのクリーンアップ ---
        const resHeaders = {};
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            // content-lengthが含まれていると表示されない最大の原因になるので除外
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options'].includes(key)) {
                res.set(k, v);
            }
        });

        // CORSとキャッシュの明示
        res.set("Access-Control-Allow-Origin", "*");
        if (req.url.includes('_p_') || /\.(webp|jpg|png|gif)$/.test(req.url)) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
        }

        res.status(response.status);

        // --- ストリーミング転送の安定化 ---
        // pipeを使う前に、確実にヘッダーが送信されるようにする
        response.body.pipe(res);

        response.body.on('error', (err) => {
            console.error('Pipe Error:', err);
            if (!res.headersSent) res.end();
        });

    } catch (error) {
        console.error('Fetch Fatal:', error.message);
        if (!res.headersSent) res.status(502).end();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stable Streaming Proxy on ${PORT}`));
