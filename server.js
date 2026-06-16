const express = require('express');
const fetch = require('node-fetch'); // ライブラリを明示的に読み込み
const app = express();
const CF_WORKER_URL = "https://manga-api-nemu.myproxy0108.workers.dev/";

app.all('*', async (req, res) => {
    try {
        const targetUrl = CF_WORKER_URL + req.url;

        const response = await fetch(targetUrl, {
            method: req.method,
            headers: {
                // ここでブラウザがアクセスしているRenderのドメイン情報をWorkersに渡す
                'X-Forwarded-Host': req.get('host'),
                'User-Agent': req.headers['user-agent'],
                'Accept': req.headers['accept'],
                'Cookie': req.headers['cookie'] || ''
            }
        });

        response.headers.forEach((v, k) => {
            if (!['content-encoding', 'transfer-encoding'].includes(k.toLowerCase())) {
                res.set(k, v);
            }
        });

        const buffer = await response.buffer();
        res.status(response.status).send(buffer);

    } catch (error) {
        res.status(500).send("Proxy Error: " + error.message);
    }
});

app.listen(process.env.PORT || 3000);
