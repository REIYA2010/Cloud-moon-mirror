const express = require('express');
const fetch = require('node-fetch'); // package.jsonに "node-fetch": "^2.7.0" が必要
const app = express();

// あなたのCloudflare WorkerのURL
const CF_WORKER_URL = "https://api-nemu.myproxy0108.workers.dev";

app.all('*', async (req, res) => {
    try {
        const targetUrl = CF_WORKER_URL + req.url;

        const response = await fetch(targetUrl, {
            method: req.method,
            headers: {
                // 自分のドメイン情報をWorkersに伝える（これで書き換えがRender向けになる）
                'X-Forwarded-Host': req.get('host'),
                'X-Forwarded-Proto': 'https',
                'User-Agent': req.headers['user-agent'],
                'Accept': req.headers['accept'],
                'Cookie': req.headers['cookie'] || ''
            },
            timeout: 30000
        });

        // ヘッダーの引き継ぎ
        const contentType = response.headers.get("content-type");
        if (contentType) res.set("Content-Type", contentType);
        res.set("Access-Control-Allow-Origin", "*");

        const buffer = await response.buffer();
        res.status(response.status).send(buffer);

    } catch (error) {
        console.error(error);
        res.status(500).send("読み込みに失敗しました。Workers側を確認してください。");
    }
});

app.listen(process.env.PORT || 3000);
