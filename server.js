const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const app = express();

// ==========================================
// 1. 設定：心臓部（Cloudflare Workers）
// ==========================================
const CF_WORKER_URLS = [
    "https://mangarw-api.myproxy0108.workers.dev",
    "https://api-nemu.myproxy0108.workers.dev",
    "https://sika-sika-manga.myproxy0108.workers.dev"
];
let workerIndex = 0;
const getWorker = () => CF_WORKER_URLS[workerIndex++ % CF_WORKER_URLS.length];

const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 256,
    timeout: 60000
});

app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ==========================================
// 2. 広告削除用エンジン（正規表現）
// ==========================================
const adBlockPatterns = [
    /<script[^>]*universityshocksooner\.com[^>]*><\/script>/gi,
    /<script[^>]*adexchangerapid\.com[^>]*><\/script>/gi,
    /<script[^>]*platform\.pubadx\.one[^>]*><\/script>/gi,
    /<script[^>]*gomuraw\.js[^>]*><\/script>/gi,
    /<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, // あなたが指摘した末尾のリンク
    /<div[^>]*id="bg-ssp"[^>]*>[\s\S]*?<\/div>/gi,   // 広告コンテナ
    /https:\/\/universityshocksooner\.com\/[^"'\s]+/gi,
    /https:\/\/adexchangerapid\.com\/[^"'\s]+/gi
];

// 注入する「広告殺し」のCSS/JS
const adKillerCode = `
<style>
  iframe, [class*="ad-"], [id*="ad-"], .pop--excl, .bg-ssp-11557, 
  [style*="z-index: 2147483647"], [style*="z-index: 9999"], #toast { 
    display: none !important; visibility: hidden !important; pointer-events: none !important; 
  }
</style>
<script>
  // 動的に現れる透明な板を削除
  setInterval(() => {
    document.querySelectorAll('div, a').forEach(el => {
      const s = window.getComputedStyle(el);
      if (parseInt(s.zIndex) > 1000 && (s.opacity === '0' || s.backgroundColor.includes('0)'))) {
        el.remove();
      }
    });
  }, 1000);
</script>
`;

// ==========================================
// 3. メイン転送ロジック
// ==========================================
app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    const selectedWorker = getWorker();
    const targetUrl = selectedWorker + req.url;

    // ヘッダーのクリーニング
    const cleanHeaders = {};
    const skipHeaders = ['host', 'connection', 'content-length', 'content-encoding', 'cf-ray', 'cf-connecting-ip', 'x-real-ip'];
    Object.keys(req.headers).forEach(key => {
        if (!skipHeaders.includes(key.toLowerCase())) cleanHeaders[key] = req.headers[key];
    });
    cleanHeaders['X-Forwarded-Host'] = req.get('host');
    cleanHeaders['X-Forwarded-Proto'] = 'https';

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: cleanHeaders,
            agent: proxyAgent,
            compress: true, 
            redirect: 'follow',
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined
        });

        // レスポンスヘッダーの設定
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options'].includes(key)) {
                res.set(k, v);
            }
        });

        const contentType = response.headers.get("content-type") || "";

        // --- 4. 広告削除の実行（HTML/JS/CSSの場合） ---
        if (contentType.includes("text/html") || contentType.includes("javascript")) {
            let text = await response.text();

            // 正規表現で広告コードを根こそぎ消す
            adBlockPatterns.forEach(pattern => {
                text = text.replace(pattern, "");
            });

            // HTMLなら広告ブロックコードを注入
            if (contentType.includes("text/html")) {
                text = text.replace('<head>', '<head>' + adKillerCode);
                // 文字化け対策
                if (!contentType.includes("charset")) res.set("Content-Type", "text/html; charset=utf-8");
            }

            return res.status(response.status).send(text);
        }

        // --- 5. 画像などは爆速ストリーミングで流す ---
        if (req.url.includes('_p_') || /\.(webp|jpg|png|gif)$/.test(req.url)) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
        }

        res.status(response.status);
        response.body.pipe(res);

    } catch (error) {
        console.error('[Fatal]', error.message);
        if (!res.headersSent) res.status(502).send("Proxy Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Super Clean Proxy running on ${PORT}`));
