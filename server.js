const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const app = express();

// ==========================================
// 1. 設定：心臓部（Cloudflare Workers）
// ==========================================
const CF_WORKER_URLS = [
    "https://mangarw-api.myproxy0108.workers.dev",
    "https://api-nemu.myproxy0108.workers.dev"
];
let workerIndex = 0;
const getWorker = () => CF_WORKER_URLS[workerIndex++ % CF_WORKER_URLS.length];

// ==========================================
// 2. 高速化：通信エージェント設定
// ==========================================
const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 512,      // 並列読み込み数を最大化
    maxFreeSockets: 128,
    timeout: 60000,       // 1分でタイムアウト
    scheduling: 'lifo'
});

// ボディ解析リミット（漫画データ転送用）
app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ==========================================
// 3. メイン転送ロジック（すべてをWorkerへ）
// ==========================================
app.all('*', async (req, res) => {
    //  faviconのリクエストなどは軽く流す
    if (req.url === '/favicon.ico') return res.status(204).end();

    const selectedWorker = getWorker();
    const targetUrl = selectedWorker + req.url;

    // ヘッダーの徹底クリーニング（Bot検知・文字化け・エラー対策）
    const cleanHeaders = {};
    const skipHeaders = ['host', 'connection', 'content-length', 'content-encoding', 'cf-ray', 'cf-connecting-ip', 'x-real-ip'];
    
    Object.keys(req.headers).forEach(key => {
        if (!skipHeaders.includes(key.toLowerCase())) {
            cleanHeaders[key] = req.headers[key];
        }
    });

    // 自分のドメイン情報をWorkersへ渡す（リンク書き換えの同期用）
    cleanHeaders['X-Forwarded-Host'] = req.get('host');
    cleanHeaders['X-Forwarded-Proto'] = 'https';

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: cleanHeaders,
            agent: proxyAgent,
            compress: true, // Render側で解凍（文字化け防止の要）
            redirect: 'follow',
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined
        });

        // レスポンスヘッダーの整理
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            // 不具合の元になるヘッダーを除外
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options'].includes(key)) {
                res.set(k, v);
            }
        });

        // 強力なキャッシュ命令（画像・静的ファイル）
        if (req.url.includes('_p_') || /\.(webp|jpg|png|gif|css|js|woff2|ico)$/.test(req.url)) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
        }

        // 文字化け強制防止（HTMLの場合）
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("text/html") && !contentType.includes("charset")) {
            res.set("Content-Type", contentType + "; charset=utf-8");
        }

        res.status(response.status);

        // 【爆速ストリーミング】データが届いたそばからブラウザに流す
        response.body.pipe(res);

        // 転送エラー時の処理
        response.body.on('error', (err) => {
            console.error('[Stream Error]', err.message);
            if (!res.headersSent) res.end();
        });

    } catch (error) {
        console.error('[Fetch Error]', error.message);
        if (!res.headersSent) {
            res.status(502).send("通信エラー: Workerに接続できませんでした。");
        }
    }
});

// ポート起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`--- FAST MANGA PROXY ONLINE ---`);
    console.log(`Targeting through ${CF_WORKER_URLS.length} Workers`);
});
