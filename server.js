const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const app = express();

// あなたのCloudflare WorkerのURL
const CF_WORKER_URL = "https://sika-sika-manga.myproxy0108.workers.dev";

app.all('*', async (req, res) => {
    // 1. Renderに届いたリクエストのパスとクエリをそのままWorkerへ飛ばす
    const targetUrl = CF_WORKER_URL + req.url;

    const response = await fetch(targetUrl, {
        method: req.method,
        headers: req.headers, // ブラウザからのヘッダーをそのまま渡す
        body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined
    });

    // 2. Workerから返ってきた結果をそのままブラウザに返す
    const contentType = response.headers.get("content-type");
    res.set("Content-Type", contentType);
    
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
});

app.listen(process.env.PORT || 3000);
