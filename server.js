const express = require('express');
const app = express();

const CF_WORKER_URL = "https://nemu-manga-api.myproxy0108.workers.dev";

app.all('*', async (req, res) => {
    try {
        const targetUrl = CF_WORKER_URL + req.url;

        const response = await fetch(targetUrl, {
            method: req.method,
            headers: {
                // ブラウザのヘッダーをそのまま渡すとRenderの情報が混じるので、
                // 必要最小限に絞って「純粋なブラウザリクエスト」に見せかける
                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': req.headers['accept'] || '*/*',
                'Accept-Language': req.headers['accept-language'] || 'ja,en-US;q=0.9',
                'Cookie': req.headers['cookie'] || ''
            },
            // タイムアウト設定（漫画サイトは重いため）
            signal: AbortSignal.timeout(15000) 
        });

        const contentType = response.headers.get("content-type");
        if (contentType) res.set("Content-Type", contentType);

        // レスポンスをチャンクごとに流す（メモリ節約・高速化）
        const arrayBuffer = await response.arrayBuffer();
        res.status(response.status).send(Buffer.from(arrayBuffer));

    } catch (error) {
        console.error("Critical Error:", error);
        res.status(500).send("読み込みに失敗しました。サイト側が一時的に制限している可能性があります。");
    }
});

app.listen(process.env.PORT || 3000);
