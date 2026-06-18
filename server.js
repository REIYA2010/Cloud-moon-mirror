const express = require('express');
const fetch = require('node-fetch');
const app = express();

// 1. 使用するCloudflare WorkersのURLを配列にすべて入れる
const CF_WORKER_URLS = [
    "https://mangarw-api.72016.workers.dev/",
    "https://api-nemu.myproxy0108.workers.dev"
    // 必要に応じてここに追加
];

// リクエストの回数を数えるためのカウンター
let requestCount = 0;

app.all('*', async (req, res) => {
    try {
        // 2. 順番にWorkerを選択する (ラウンドロビン方式)
        // リクエストごとに 0番目 -> 1番目 -> 2番目 -> 0番目... と切り替わる
        const workerIndex = requestCount % CF_WORKER_URLS.length;
        const selectedWorker = CF_WORKER_URLS[workerIndex];
        requestCount++;

        const targetUrl = selectedWorker + req.url;

        // デバッグ用（どのWorkerが使われたかRenderのログに出す）
        console.log(`[Proxy] Using Worker #${workerIndex}: ${selectedWorker}${req.url}`);

        const response = await fetch(targetUrl, {
            method: req.method,
            headers: {
                // 自分のドメイン情報をWorkersに伝える
                'X-Forwarded-Host': req.get('host'),
                'X-Forwarded-Proto': 'https',
                'User-Agent': req.headers['user-agent'],
                'Accept': req.headers['accept'],
                'Cookie': req.headers['cookie'] || ''
            },
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined,
            timeout: 30000
        });

        // ヘッダーの引き継ぎ
        const contentType = response.headers.get("content-type");
        if (contentType) res.set("Content-Type", contentType);
        res.set("Access-Control-Allow-Origin", "*");

        // 本家から返ってきた特殊なヘッダー（Set-Cookie等）があれば引き継ぐ
        const setCookie = response.headers.get("set-cookie");
        if (setCookie) res.set("Set-Cookie", setCookie);

        const buffer = await response.buffer();
        res.status(response.status).send(buffer);

    } catch (error) {
        console.error(`[Error] Worker request failed: ${error.message}`);
        res.status(500).send("分散プロキシエラー: 接続に失敗しました。");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Load balancer running with ${CF_WORKER_URLS.length} workers on port ${PORT}`);
});
