const express = require('express');
const app = express();

// あなたのCloudflare WorkerのURL
const CF_WORKER_URL = "https://sika-sika-manga.myproxy0108.workers.dev";

app.all('*', async (req, res) => {
    try {
        // パスとクエリを引き継いでWorkerに飛ばす
        const targetUrl = CF_WORKER_URL + req.url;

        // Node.js標準のfetchを使用（ライブラリ不要）
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: {
                // 元のリクエストヘッダーからHost以外を引き継ぐ
                ...req.headers,
                'host': new URL(CF_WORKER_URL).host
            },
            // GET/HEAD以外の場合はボディを転送
            body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined
        });

        // レスポンスヘッダーの処理
        response.headers.forEach((value, key) => {
            res.set(key, value);
        });

        // データを取り出してブラウザに返す
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        res.status(response.status).send(buffer);

    } catch (error) {
        console.error("Fetch Error:", error);
        res.status(500).send("Proxy Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
