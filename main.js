const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const app = express();

const CF_WORKER_URLS = [
    "https://api-nemu.myproxy0108.workers.dev",
    "https://mangarw-api.myproxy0108.workers.dev"
];
let workerIndex = 0;
const getWorker = () => CF_WORKER_URLS[workerIndex++ % CF_WORKER_URLS.length];

const proxyAgent = new https.Agent({ keepAlive: true, maxSockets: 150 });

// 広告削除用コード
const INJECT_CODE = `
<style>
  iframe, .pop--excl, .bg-ssp-11557, [id*="bg-ssp"], [class*="ad-"], 
  [style*="z-index: 2147483647"], [style*="z-index: 9999"], #toast { display: none !important; }
  #load-more-chapters, .load-more { display: block !important; visibility: visible !important; background: #3b82f6 !important; color: white !important; padding: 15px !important; text-align: center; border-radius: 8px; font-weight: bold; }
</style>
<script>
  (function() {
    window.open = () => null;
    const nuke = () => {
      document.querySelectorAll('div, a').forEach(el => {
        const s = window.getComputedStyle(el);
        if (parseInt(s.zIndex) > 100 && s.opacity === '0' && !el.innerText.trim()) el.remove();
        if (el.href && (el.href.includes('adex') || el.href.includes('university'))) el.remove();
      });
    };
    setInterval(nuke, 1000);
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

app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    const selectedWorker = getWorker();
    const targetUrl = selectedWorker + req.url;
    const currentHost = req.get('host');

    // 1. ヘッダーの整理
    const cleanHeaders = {};
    for (let key in req.headers) {
        if (!['host', 'connection', 'content-length', 'content-encoding', 'accept-encoding'].includes(key.toLowerCase())) {
            cleanHeaders[key] = req.headers[key];
        }
    }
    // 【文字化け対策の核心】Workerに圧縮させない
    cleanHeaders['accept-encoding'] = 'identity';
    cleanHeaders['X-Forwarded-Host'] = currentHost;
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

        // 2. 応答ヘッダーの整理（圧縮ヘッダーを捨てる）
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options'].includes(key)) {
                res.set(k, v);
            }
        });

        const contentType = response.headers.get("content-type") || "";

        // --- HTML・テキスト処理モード ---
        if (contentType.includes("text/html") || contentType.includes("application/javascript") || contentType.includes("text/css")) {
            // 文字コードを明示的に指定して取得（文字化け防止）
            const buffer = await response.arrayBuffer();
            const decoder = new TextDecoder('utf-8');
            let text = decoder.decode(buffer);

            if (contentType.includes("text/html")) {
                // 広告ドメインの物理消去
                const adDomains = ['universityshocksooner.com', 'adexchangerapid.com', 'platform.pubadx.one', 'gomuraw.js'];
                adDomains.forEach(d => {
                    text = text.replace(new RegExp('<script[^>]*' + d.replace('.', '\\.') + '[^>]*><\\/script>', 'gi'), "");
                    text = text.split(d).join("localhost");
                });
                text = text.replace(/<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, "");
                
                // ドメイン同期
                text = text.split("myproxy0108.workers.dev").join(currentHost);
                
                // コード注入
                text = text.replace('<head>', '<head>' + INJECT_CODE);
                
                res.set("Content-Type", "text/html; charset=utf-8");
            }

            return res.status(response.status).send(text);
        }

        // --- バイナリ（画像）モード ---
        if (req.url.includes('_p_')) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
        }
        
        const finalBuffer = await response.buffer();
        res.status(response.status).send(finalBuffer);

    } catch (error) {
        if (!res.headersSent) res.status(502).send("Error: " + error.message);
    }
});

module.exports = app;
