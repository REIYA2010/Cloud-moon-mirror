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

// 通信安定化エージェント
const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 600,
    timeout: 60000
});

app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ==========================================
// 2. 広告抹殺パターン設定
// ==========================================
const AD_DOMAINS = [
    'universityshocksooner.com',
    'adexchangerapid.com',
    'platform.pubadx.one',
    'preferencenail.com',
    'gomuraw.js',
    'vntsm.com'
];

// ブラウザ内で動く強力な広告クリーナー
const INJECT_CODE = `
<style>
  /* 広告枠を強制非表示 */
  iframe, .pop--excl, .bg-ssp-11557, [id*="bg-ssp"], [class*="ad-"], 
  [style*="2147483647"], [style*="9999"], #toast { 
    display: none !important; visibility: hidden !important; pointer-events: none !important; 
  }
  /* 続きを読むボタンを保護 */
  #load-more-chapters, .load-more, .read-more {
    display: block !important; visibility: visible !important; opacity: 1 !important;
    background-color: #3b82f6 !important; color: white !important;
  }
</style>
<script>
  (function() {
    // 1. ポップアップを殺す
    window.open = function() { return null; };
    
    // 2. 動的な透明オーバーレイを監視して削除
    const nuke = () => {
      document.querySelectorAll('div, a').forEach(el => {
        const s = window.getComputedStyle(el);
        if (parseInt(s.zIndex) > 100 && (s.opacity === '0' || s.backgroundColor.includes('0)'))) {
          if(!el.innerText.trim()) el.remove();
        }
        if (el.href && (el.href.includes('adex') || el.href.includes('university'))) el.remove();
      });
    };
    setInterval(nuke, 2000);

    // 3. 画像の5枚先読み（高速化）
    const prefetch = () => {
      const imgs = Array.from(document.querySelectorAll('img[data-src]'));
      const obs = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const idx = imgs.indexOf(entry.target);
            for(let i=1; i<=5; i++) {
              if(imgs[idx+i]) imgs[idx+i].src = imgs[idx+i].dataset.src;
            }
          }
        });
      }, { rootMargin: '3000px' });
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

    // ヘッダー整理
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    headers['X-Forwarded-Host'] = req.get('host');
    headers['X-Forwarded-Proto'] = 'https';

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: headers,
            agent: proxyAgent,
            compress: true, 
            redirect: 'follow',
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined
        });

        // レスポンスヘッダーの設定
        response.headers.forEach((v, k) => {
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy'].includes(k.toLowerCase())) {
                res.set(k, v);
            }
        });

        const contentType = response.headers.get("content-type") || "";

        // --- HTMLの場合：広告を検閲・物理削除 ---
        if (contentType.includes("text/html")) {
            let text = await response.text();

            // 1. 指定ドメインの広告コードを物理削除
            AD_DOMAINS.forEach(domain => {
                const regex = new RegExp('<script[^>]*' + domain.replace('.', '\\.') + '[^>]*><\\/script>', 'gi');
                text = text.replace(regex, "");
                // 文字列としての出現もlocalhostに飛ばして無効化
                text = text.split(domain).join("localhost");
            });

            // 2. 指摘のあった末尾の強制リンクを削除
            text = text.replace(/<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, "");

            // 3. 広告ブロックコードと先読みJSを注入
            text = text.replace('<head>', '<head>' + INJECT_CODE);

            // 4. 文字化け対策
            res.set("Content-Type", "text/html; charset=utf-8");
            return res.status(response.status).send(text);
        }

        // --- 画像・JS・CSSの場合：爆速ストリーミング ---
        if (req.url.includes('_p_')) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
        }
        res.status(response.status);
        response.body.pipe(res);

    } catch (error) {
        console.error('Fatal Error:', error.message);
        if (!res.headersSent) res.status(502).send("Proxy Error");
    }
});

const PORT = process.env.PORT || 3000;
module.exports = app;
