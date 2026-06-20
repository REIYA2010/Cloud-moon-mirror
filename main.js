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

// 広告ブロック ＆ 先読みエンジン（前回と同じ最強版）
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
      }, { rootMargin: '1200px' });
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

    const cleanHeaders = {};
    for (let key in req.headers) {
        if (!['host', 'connection', 'content-length', 'content-encoding', 'accept-encoding'].includes(key.toLowerCase())) {
            cleanHeaders[key] = req.headers[key];
        }
    }
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

        const contentType = response.headers.get("content-type") || "";

        // --- 1. 重要：画像プロキシリクエストの処理 ---
        if (req.url.includes('_p_') || contentType.includes("image")) {
            const buffer = await response.buffer();
            
            // 画像用ヘッダー設定
            res.set({
                "Content-Type": contentType,
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "public, max-age=31536000, immutable",
                "X-Proxy-Status": "Image-Active"
            });
            
            return res.status(response.status).send(buffer);
        }

        // --- 2. HTML/Text 処理モード（文字化け対策込み） ---
        if (contentType.includes("text/html") || contentType.includes("javascript") || contentType.includes("css")) {
            const buffer = await response.arrayBuffer();
            const decoder = new TextDecoder('utf-8');
            let text = decoder.decode(buffer);

            if (contentType.includes("text/html")) {
                // 広告削除
                const adDomains = ['universityshocksooner.com', 'adexchangerapid.com', 'platform.pubadx.one', 'gomuraw.js'];
                adDomains.forEach(d => {
                    text = text.replace(new RegExp('<script[^>]*' + d.replace('.', '\\.') + '[^>]*><\\/script>', 'gi'), "");
                    text = text.split(d).join("localhost");
                });
                text = text.replace(/<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, "");
                
                // ドメイン同期 ＆ 広告殺し注入
                text = text.split("myproxy0108.workers.dev").join(currentHost);
                text = text.replace('<head>', '<head>' + INJECT_CODE);
                
                res.set("Content-Type", "text/html; charset=utf-8");
            } else {
                res.set("Content-Type", contentType);
            }

            res.set("Access-Control-Allow-Origin", "*");
            return res.status(response.status).send(text);
        }

        // --- 3. その他（JSONなど） ---
        const finalBuffer = await response.buffer();
        res.set("Access-Control-Allow-Origin", "*");
        res.status(response.status).send(finalBuffer);

    } catch (error) {
        if (!res.headersSent) res.status(502).send("Error: " + error.message);
    }
});

module.exports = app;
