const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const app = express();

// ==========================================
// 1. 設定：心臓部（Cloudflare Workers）
// ==========================================
const CF_WORKER_URLS = [
    "https://mangarw-api.72016.workers.dev",
    "https://api-nemu.myproxy0108.workers.dev"
];
let globalIndex = 0;

const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 600,
    timeout: 60000
});

app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ==========================================
// 2. 注入：1秒おき透明ボタン監視・抹殺スクリプト
// ==========================================
const INJECT_CODE = `
<style>
  /* 既知の広告枠をCSSで即座に消す */
  iframe, .pop--excl, .bg-ssp-11557, [id*="bg-ssp"], [class*="ad-"], #toast,
  [style*="z-index: 2147483647"], [style*="z-index: 9999"] { 
    display: none !important; visibility: hidden !important; pointer-events: none !important; 
  }
  /* 続きを読むボタン等のUIは絶対に消さない */
  #load-more-chapters, .load-more, .read-more { 
    display: block !important; visibility: visible !important; opacity: 1 !important;
  }
</style>
<script>
  (function() {
    // ポップアップを根本から無効化
    window.open = function() { console.log('Ad-popup blocked'); return null; };

    // 【核心】1秒おきに透明な広告板を監視して削除する関数
    const nukeTransparentAds = () => {
      // ページ内のすべてのdivとaタグをチェック
      document.querySelectorAll('div, a, ins, section').forEach(el => {
        const s = window.getComputedStyle(el);
        const zIndex = parseInt(s.zIndex);
        const opacity = parseFloat(s.opacity);
        
        // 条件：z-indexが1000以上で、かつ透明に近い要素
        const isSuspicious = zIndex > 1000 && (opacity < 0.1 || s.backgroundColor.includes('rgba(0, 0, 0, 0)'));
        
        if (isSuspicious) {
          // 漫画のボタン（テキストがあるもの）は除外する安全策
          if (el.innerText.trim().length === 0) {
            el.remove();
            console.log('Nuked a transparent ad overlay');
          }
        }

        // adexchangerapidなどの特定ドメインリンクも削除
        if (el.href && (el.href.includes('adex') || el.href.includes('university'))) {
          el.remove();
        }
      });
    };

    // 1秒ごとに実行
    setInterval(nukeTransparentAds, 1000);

    // 画像の5枚先読み（スクロールをスムーズに）
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
// 3. 故障検知（Failover）付き取得ロジック
// ==========================================
async function fetchWithRetry(req, targetUrlPath, attempt = 0) {
    if (attempt >= CF_WORKER_URLS.length) throw new Error("All Workers Failed");

    const currentWorker = CF_WORKER_URLS[(globalIndex + attempt) % CF_WORKER_URLS.length];
    const targetUrl = currentWorker + targetUrlPath;

    const h = { ...req.headers };
    delete h.host; delete h.connection; delete h['content-length'];
    h['X-Forwarded-Host'] = req.get('host');
    h['X-Forwarded-Proto'] = 'https';

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: h,
            agent: proxyAgent,
            compress: true,
            redirect: 'follow',
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined,
            timeout: 12000
        });

        if (response.status === 1101 || response.status >= 500) {
            return fetchWithRetry(req, targetUrlPath, attempt + 1);
        }
        return response;
    } catch (err) {
        return fetchWithRetry(req, targetUrlPath, attempt + 1);
    }
}

// ==========================================
// 4. メインルーティング
// ==========================================
app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    try {
        const response = await fetchWithRetry(req, req.url);
        globalIndex = (globalIndex + 1) % CF_WORKER_URLS.length;

        response.headers.forEach((v, k) => {
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options'].includes(k.toLowerCase())) {
                res.set(k, v);
            }
        });

        const contentType = response.headers.get("content-type") || "";

        if (contentType.includes("text/html")) {
            let text = await response.text();
            
            // 物理削除：adexchangerapidとuniversityを消し去る
            text = text.replace(/<script[^>]*universityshocksooner\.com[^>]*><\/script>/gi, "");
            text = text.replace(/<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, "");
            text = text.split("universityshocksooner.com").join("localhost");

            // 広告抹殺コードを注入
            text = text.replace('<head>', '<head>' + INJECT_CODE);

            res.set("Content-Type", "text/html; charset=utf-8");
            return res.status(response.status).send(text);
        }

        // 画像・アセットはストリーミング
        res.status(response.status);
        response.body.pipe(res);

    } catch (error) {
        if (!res.headersSent) res.status(502).send("Service Temporarily Unavailable");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Super Clean Proxy running on ${PORT}`));
