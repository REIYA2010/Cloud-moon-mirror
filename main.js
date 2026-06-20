const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const app = express();

// ==========================================
// 1. 設定：心臓部（Cloudflare Workers）
// ==========================================
const CF_WORKER_URLS = [
    "https://api-nemu.myproxy0108.workers.dev",
    "https://mangarw-api.myproxy0108.workers.dev"
];
let workerIndex = 0;
const getWorker = () => CF_WORKER_URLS[workerIndex++ % CF_WORKER_URLS.length];

const proxyAgent = new https.Agent({ keepAlive: true, maxSockets: 150 });
app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ==========================================
// 2. 注入：広告抹殺コード ＆ 5枚先読みエンジン
// ==========================================
const INJECT_CODE = `
<style>
  iframe, .pop--excl, .bg-ssp-11557, [id*="bg-ssp"], [style*="z-index: 2147483647"], #toast { display: none !important; }
  #load-more-chapters, .load-more { display: block !important; visibility: visible !important; background: #3b82f6 !important; color: white !important; padding: 15px !important; text-align: center; border-radius: 8px; margin: 20px 0; font-weight: bold; cursor: pointer; }
</style>
<script>
  (function() {
    window.open = () => null; // ポップアップ防止
    const nuke = () => {
      document.querySelectorAll('div, a').forEach(el => {
        const s = window.getComputedStyle(el);
        if (parseInt(s.zIndex) > 1000 && s.opacity === '0' && !el.innerText.trim()) el.remove();
        if (el.href && (el.href.includes('adex') || el.href.includes('university'))) el.remove();
      });
    };
    setInterval(nuke, 800);
    const prefetch = () => {
      const imgs = Array.from(document.querySelectorAll('img[data-src]'));
      const obs = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const idx = imgs.indexOf(entry.target);
            for(let i=1; i<=5; i++) if(imgs[idx+i]) imgs[idx+i].src = imgs[idx+i].dataset.src;
          }
        });
      }, { rootMargin: '1000px' });
      imgs.forEach(img => obs.observe(img));
    };
    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', prefetch) : prefetch();
  })();
</script>
`;

// ==========================================
// 3. メインプロキシ：Vercel最適化
// ==========================================
app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    const selectedWorker = getWorker();
    const targetUrl = selectedWorker + req.url;
    const currentHost = req.get('host');

    // ヘッダー整理
    const cleanHeaders = {};
    for (let key in req.headers) {
        if (!['host', 'connection', 'content-length', 'content-encoding', 'cf-ray'].includes(key.toLowerCase())) {
            cleanHeaders[key] = req.headers[key];
        }
    }
    cleanHeaders['X-Forwarded-Host'] = currentHost;
    cleanHeaders['X-Forwarded-Proto'] = 'https';

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: cleanHeaders,
            agent: proxyAgent,
            compress: true, // 解凍（文字化け防止）
            redirect: 'follow',
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined
        });

        // 応答ヘッダーの整理
        response.headers.forEach((v, k) => {
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options'].includes(k.toLowerCase())) {
                res.set(k, v);
            }
        });

        const contentType = response.headers.get("content-type") || "";

        // --- HTML検閲モード ---
        if (contentType.includes("text/html")) {
            let text = await response.text();

            // 1. 広告ドメインを物理削除
            const adDomains = ['universityshocksooner.com', 'adexchangerapid.com', 'platform.pubadx.one', 'gomuraw.js'];
            adDomains.forEach(d => {
                text = text.replace(new RegExp('<script[^>]*' + d.replace('.', '\\.') + '[^>]*><\\/script>', 'gi'), "");
                text = text.split(d).join("localhost");
            });

            // 2. 指摘された末尾の隠しリンクを削除
            text = text.replace(/<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, "");

            // 3. ドメインの再同期（Vercelドメインへの強制置換）
            text = text.split("myproxy0108.workers.dev").join(currentHost);

            // 4. クリーナーと先読みJSを注入
            text = text.replace('<head>', '<head>' + INJECT_CODE);

            res.set("Content-Type", "text/html; charset=utf-8");
            return res.status(response.status).send(text);
        }

        // --- アセット（画像等）モード ---
        if (req.url.includes('_p_')) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
        }
        
        // Vercel環境ではpipeよりbufferが安定
        const buffer = await response.buffer();
        res.status(response.status).send(buffer);

    } catch (error) {
        console.error('Vercel Proxy Error:', error.message);
        if (!res.headersSent) res.status(502).send("Proxy Node Error: " + error.message);
    }
});

module.exports = app;
