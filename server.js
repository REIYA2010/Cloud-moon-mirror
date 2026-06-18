const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();

// ==========================================
// 1. 設定：心臓部（Cloudflare Workers）の登録
// ==========================================
const CF_WORKER_URLS = [
    "https://mangarw-api.myproxy0108.workers.dev",
    "https://api-nemu.myproxy0108.workers.dev"
];
let workerIndex = 0;

const getWorker = () => CF_WORKER_URLS[workerIndex++ % CF_WORKER_URLS.length];

// ==========================================
// 2. 高速化：通信エージェントの設定
// ==========================================
const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 512,      // 漫画の大量画像に耐える
    maxFreeSockets: 128,
    timeout: 90000,
    scheduling: 'lifo'    // 新しい画像を優先してパッと出す
});

// ボディ解析のリミット（大容量通信対応）
app.use(express.raw({ type: '*/*', limit: '100mb' }));

// ==========================================
// 3. UI：ポータル画面（検索・URL入力）
// ==========================================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Ultimate Portal</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            body { background: #080808; color: #e0e0e0; font-family: 'Inter', sans-serif; }
            .glass { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.05); }
            .glow:hover { box-shadow: 0 0 20px rgba(0, 212, 255, 0.4); }
        </style>
    </head>
    <body class="flex items-center justify-center min-h-screen overflow-hidden">
        <div class="glass p-10 rounded-3xl shadow-2xl w-full max-w-lg text-center glow transition-all">
            <h1 class="text-4xl font-black mb-2 bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">PORTAL</h1>
            <p class="text-gray-500 mb-8 text-sm uppercase tracking-widest">MDM & Ad-Block System</p>
            
            <div class="space-y-4">
                <input type="text" id="url" placeholder="URLを入力するか検索ワードを入力..." 
                       class="w-full p-4 rounded-xl bg-black/50 border border-white/10 focus:border-blue-500 outline-none transition-all text-white">
                
                <div class="grid grid-cols-2 gap-3">
                    <button onclick="go('/manga/https://mangarw.com')" class="p-3 bg-white/5 hover:bg-white/10 rounded-xl transition-all">MangaRaw</button>
                    <button onclick="go('/manga/https://web.cloudmoonapp.com')" class="p-3 bg-white/5 hover:bg-white/10 rounded-xl transition-all">CloudMoon</button>
                    <button onclick="go('/manga/https://bloxd.io')" class="p-3 bg-white/5 hover:bg-white/10 rounded-xl transition-all">Bloxd.io</button>
                    <button onclick="go('/manga/https://poki.com/jp')" class="p-3 bg-white/5 hover:bg-white/10 rounded-xl transition-all">Poki Games</button>
                </div>

                <button onclick="launch()" class="w-full p-4 bg-gradient-to-r from-blue-600 to-cyan-500 text-black font-bold rounded-xl shadow-lg hover:scale-[1.02] active:scale-95 transition-all">
                    アクセス開始
                </button>
            </div>
            <p class="mt-6 text-[10px] text-gray-600 italic">Connected to ${CF_WORKER_URLS.length} heart nodes.</p>
        </div>

        <script>
            function go(path) { window.location.href = path; }
            function launch() {
                let v = document.getElementById('url').value.trim();
                if(!v) return;
                if(!v.startsWith('http')) v = "https://www.google.com/search?q=" + encodeURIComponent(v);
                window.location.href = "/manga/" + v;
            }
            document.getElementById('url').onkeydown = (e) => { if(e.key === 'Enter') launch(); };
        </script>
    </body>
    </html>
    `);
});

// ==========================================
// 4. 通信部：WebSocket（オンラインゲーム）対応
// ==========================================
const wsProxy = createProxyMiddleware({
    target: CF_WORKER_URLS[0], // 代表して1つ目のWorkerを指定（routerで動的に変える）
    router: () => getWorker(),
    changeOrigin: true,
    ws: true,
    onProxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-Forwarded-Host', req.get('host'));
        proxyReq.setHeader('X-Forwarded-Proto', 'https');
    },
    logLevel: 'silent'
});
app.use('/manga', wsProxy); // WebSocketリクエストを吸い上げる

// ==========================================
// 5. 転送部：全通信のプロキシ ＆ 広告・表示修正
// ==========================================
app.all('/manga*', async (req, res) => {
    const selectedWorker = getWorker();
    const targetUrl = selectedWorker + req.url;

    // ヘッダーのクリーニング
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
            compress: true, // Renderで解凍して文字化けを完全に防ぐ
            redirect: 'follow',
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined
        });

        // 1101エラー等の際のフォールバック
        if (!response.ok && response.status !== 304) {
            console.error(`[Worker Error] Status: ${response.status}`);
        }

        // レスポンスヘッダーの整理
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options'].includes(key)) {
                res.set(k, v);
            }
        });

        // 強力なキャッシュとCORS設定
        res.set("Access-Control-Allow-Origin", "*");
        if (req.url.includes('_p_') || /\.(webp|jpg|png|gif|css|js|woff2)$/.test(req.url)) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
        }

        // 文字化け強制防止
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("text/html") && !contentType.includes("charset")) {
            res.set("Content-Type", contentType + "; charset=utf-8");
        }

        res.status(response.status);

        // ------------------------------------------
        // 【究極の高速化】ストリーミング転送
        // ------------------------------------------
        response.body.pipe(res);

        response.body.on('error', (err) => {
            console.error('[Stream Error]', err.message);
            if (!res.headersSent) res.end();
        });

    } catch (error) {
        console.error('[Fatal Error]', error.message);
        if (!res.headersSent) res.status(502).send("Proxy Node Error");
    }
});

// ポート起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`--- ULTIMATE PROXY SYSTEM ONLINE ---`);
    console.log(`Port: ${PORT}`);
    console.log(`Active Workers: ${CF_WORKER_URLS.length}`);
});
