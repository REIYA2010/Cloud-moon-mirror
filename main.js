const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const app = express();

// ==========================================
// 1. 設定：あなたのWorker URL群
// ==========================================
const CF_WORKER_URLS = [
    "https://sika-sika-manga.myproxy0108.workers.dev",
    "https://mangarw-api.myproxy0108.workers.dev",
    "https://api-nemu.myproxy0108.workers.dev"
];
let workerIndex = 0;
const getWorker = () => CF_WORKER_URLS[workerIndex++ % CF_WORKER_URLS.length];

const proxyAgent = new https.Agent({ keepAlive: true, maxSockets: 150 });

// ボディ解析制限（バイナリを壊さないため）
app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ==========================================
// 2. 広告抹殺コード
// ==========================================
const AD_DOMAINS = [
    'universityshocksooner.com',
    'adexchangerapid.com',
    'platform.pubadx.one',
    'gomuraw.js'
];

const INJECT_CODE = `
<style>
  iframe, .pop--excl, .bg-ssp-11557, [id*="bg-ssp"], 
  [style*="z-index: 2147483647"], [style*="z-index: 9999"], #toast { 
    display: none !important; visibility: hidden !important; pointer-events: none !important; 
  }
  #load-more-chapters, .load-more, .read-more {
    display: block !important; visibility: visible !important; opacity: 1 !important;
    background-color: #3b82f6 !important; color: white !important; padding: 12px !important;
    text-align: center; border-radius: 8px; margin: 15px auto; cursor: pointer;
  }
</style>
<script>
  (function() {
    window.open = () => null;
    const nuke = () => {
      document.querySelectorAll('div, a').forEach(el => {
        const s = window.getComputedStyle(el);
        if (parseInt(s.zIndex) > 1000 && s.opacity === '0') el.remove();
        if (el.href && (el.href.includes('adex') || el.href.includes('university'))) el.remove();
      });
    };
    setInterval(nuke, 1500);
  })();
</script>
`;

// ==========================================
// 3. メインプロキシロジック
// ==========================================
app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    const selectedWorker = getWorker();
    const targetUrl = selectedWorker + req.url;

    // ヘッダークリーニング（Vercel/Worker間の不具合防止）
    const cleanHeaders = {};
    for (let key in req.headers) {
        if (!['host', 'connection', 'content-length', 'content-encoding', 'cf-ray', 'cf-connecting-ip'].includes(key.toLowerCase())) {
            cleanHeaders[key] = req.headers[key];
        }
    }
    cleanHeaders['X-Forwarded-Host'] = req.get('host');
    cleanHeaders['X-Forwarded-Proto'] = 'https';
    // Workerに解凍させず、Node側で解凍を制御（文字化け対策）
    cleanHeaders['accept-encoding'] = 'identity';

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: cleanHeaders,
            agent: proxyAgent,
            compress: true, 
            redirect: 'follow',
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined
        });

        // 応答ヘッダーの同期
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options'].includes(key)) {
                res.set(k, v);
            }
        });

        const contentType = response.headers.get("content-type") || "";

        // --- HTML：広告削除 ＆ UTF-8固定 ---
        if (contentType.includes("text/html")) {
            let text = await response.text();

            // 広告ドメインを物理削除
            AD_DOMAINS.forEach(domain => {
                const regex = new RegExp('<script[^>]*' + domain.replace('.', '\\.') + '[^>]*><\\/script>', 'gi');
                text = text.replace(regex, "");
                text = text.split(domain).join("localhost");
            });

            // 強制リンクの削除
            text = text.replace(/<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, "");
            
            // コード注入
            text = text.replace('<head>', '<head>' + INJECT_CODE);

            res.set("Content-Type", "text/html; charset=utf-8");
            return res.status(response.status).send(text);
        }

        // --- 画像・アセット：高速転送 ---
        if (req.url.includes('_proxy_') || req.url.includes('_p_') || contentType.includes("image")) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
            res.set('Access-Control-Allow-Origin', '*');
            
            // Vercelでは画像の安定性のためにbufferで取得
            const buffer = await response.buffer();
            return res.status(response.status).send(buffer);
        }

        // その他（JS/CSSなど）
        const finalBuffer = await response.buffer();
        res.status(response.status).send(finalBuffer);

    } catch (error) {
        if (!res.headersSent) res.status(502).send("Worker Connection Error");
    }
});

// Vercel用にエクスポート
module.exports = app;
