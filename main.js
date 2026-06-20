const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const app = express();

// ==========================================
// 1. 設定：4つのWorkerを同期
// ==========================================
const CF_WORKER_URLS = [
    "https://mangarw-api.72016.workers.dev",
    "https://api-nemu.myproxy0108.workers.dev"
];
let workerIndex = 0;
const getWorker = () => CF_WORKER_URLS[workerIndex++ % CF_WORKER_URLS.length];

const proxyAgent = new https.Agent({ keepAlive: true, maxSockets: 150 });

app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ==========================================
// 2. 広告抹殺コード ＆ 先読みエンジン
// ==========================================
const AD_DOMAINS = [
    'universityshocksooner.com',
    'adexchangerapid.com',
    'platform.pubadx.one',
    'gomuraw.js',
    'preferencenail.com'
];

const INJECT_CODE = `
<style>
  /* 広告・ポップアップの徹底排除 */
  iframe, .pop--excl, .bg-ssp-11557, [id*="bg-ssp"], [class*="ad-"], 
  [style*="z-index: 2147483647"], [style*="9999"], #toast { 
    display: none !important; visibility: hidden !important; pointer-events: none !important; 
  }
  /* 続きを読むボタンを強制表示 */
  #load-more-chapters, .load-more, .read-more {
    display: block !important; visibility: visible !important; opacity: 1 !important;
    background-color: #3b82f6 !important; color: white !important; padding: 15px !important;
    text-align: center; border-radius: 8px; margin: 15px auto; cursor: pointer;
  }
</style>
<script>
  (function() {
    window.open = function() { return null; }; // 広告タブ防止
    
    // 動的な透明ボタンを抹殺
    const nuke = () => {
      document.querySelectorAll('div, a').forEach(el => {
        const s = window.getComputedStyle(el);
        if (parseInt(s.zIndex) > 1000 && s.opacity === '0' && !el.innerText.trim()) el.remove();
        if (el.href && (el.href.includes('adex') || el.href.includes('university'))) el.remove();
      });
    };
    setInterval(nuke, 1500);

    // 画像の5枚先読み（スクロール高速化）
    const prefetch = () => {
      const imgs = Array.from(document.querySelectorAll('img[data-src]'));
      const obs = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const idx = imgs.indexOf(entry.target);
            for(let i=1; i<=5; i++) {
              if(imgs[idx+i] && imgs[idx+i].dataset.src) imgs[idx+i].src = imgs[idx+i].dataset.src;
            }
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
// 3. メインプロキシロジック
// ==========================================
app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    const selectedWorker = getWorker();
    const targetUrl = selectedWorker + req.url;
    const currentHost = req.get('host');

    const cleanHeaders = {};
    for (let key in req.headers) {
        if (!['host', 'connection', 'content-length', 'content-encoding', 'cf-ray', 'cf-connecting-ip'].includes(key.toLowerCase())) {
            cleanHeaders[key] = req.headers[key];
        }
    }
    cleanHeaders['X-Forwarded-Host'] = currentHost;
    cleanHeaders['X-Forwarded-Proto'] = 'https';
    cleanHeaders['accept-encoding'] = 'identity'; // Workerに圧縮させない（文字化け防止）

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: cleanHeaders,
            agent: proxyAgent,
            compress: true, 
            redirect: 'follow',
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined
        });

        // 応答ヘッダーの整理
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options'].includes(key)) {
                res.set(k, v);
            }
        });

        const contentType = response.headers.get("content-type") || "";

        // --- A. HTML処理モード（広告削除 & 文字化け対策） ---
        if (contentType.includes("text/html")) {
            const buffer = await response.arrayBuffer();
            const decoder = new TextDecoder('utf-8');
            let text = decoder.decode(buffer);

            // 広告コードを物理削除
            AD_DOMAINS.forEach(domain => {
                const regex = new RegExp('<script[^>]*' + domain.replace('.', '\\.') + '[^>]*><\\/script>', 'gi');
                text = text.replace(regex, "");
                text = text.split(domain).join("localhost");
            });

            // 指摘された末尾の隠しリンクを削除
            text = text.replace(/<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, "");

            // 全てのWorkerドメインと本家ドメインを今のVercelドメインに同期
            const replaceHosts = ["mangarw.com", "myproxy0108.workers.dev", "72016.workers.dev"];
            replaceHosts.forEach(h => {
                text = text.split(h).join(currentHost);
            });

            // コード注入
            text = text.replace('<head>', '<head>' + INJECT_CODE);

            res.set("Content-Type", "text/html; charset=utf-8");
            res.set("Access-Control-Allow-Origin", "*");
            return res.status(response.status).send(text);
        }

        // --- B. アセット（画像等）モード ---
        if (req.url.includes('_p_') || req.url.includes('_img_proxy_') || contentType.includes("image")) {
            res.set({
                "Cache-Control": "public, max-age=31536000, immutable",
                "Access-Control-Allow-Origin": "*"
            });
            const buffer = await response.buffer();
            return res.status(response.status).send(buffer);
        }

        // その他
        const finalBuffer = await response.buffer();
        res.status(response.status).send(finalBuffer);

    } catch (error) {
        if (!res.headersSent) res.status(502).send("Worker Connection Error: " + error.message);
    }
});

module.exports = app;
