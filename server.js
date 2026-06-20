const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const app = express();

// ==========================================
// 1. 設定：分散用Worker URL（あなたのURLに同期）
// ==========================================
const CF_WORKER_URLS = [
    "https://mangarw-api.72016.workers.dev",
    "https://api-nemu.myproxy0108.workers.dev"
];
let globalIndex = 0;

// 通信安定化エージェント
const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 512,
    timeout: 60000
});

app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ==========================================
// 2. 注入：広告抹殺 ＆ 5枚先読みエンジン (完全版)
// ==========================================
const INJECT_CODE = `
<style>
  /* 広告・不要要素の物理排除 */
  iframe, .pop--excl, .bg-ssp-11557, [id*="bg-ssp"], [class*="ad-"], #toast,
  [style*="z-index: 2147483647"], [style*="z-index: 9999"], 
  a[href*="adexchangerapid"], a[href*="university"] { 
    display: none !important; visibility: hidden !important; pointer-events: none !important; 
  }
  /* UIの保護 */
  #load-more-chapters, .load-more, .read-more { 
    display: block !important; visibility: visible !important; opacity: 1 !important;
    background: #3b82f6 !important; color: white !important; border-radius: 8px;
  }
</style>
<script>
  (function() {
    // 1. ポップアップ広告を強制無効化
    window.open = function() { return null; };

    // 2. 【核心】透明ボタン監視・破壊エンジン（1秒おき）
    const nukeOverlays = () => {
      document.querySelectorAll('div, a, section, ins').forEach(el => {
        const s = window.getComputedStyle(el);
        const z = parseInt(s.zIndex);
        // z-indexが高い透明な板、または広告ドメインへのリンクを即削除
        if ((z > 1000 && parseFloat(s.opacity) < 0.1) || 
            (el.href && (el.href.includes('adex') || el.href.includes('university')))) {
          if (!el.innerText.trim()) el.remove();
        }
      });
    };
    setInterval(nukeOverlays, 1000);

    // 3. 【核心】5枚先読み・スクロール最適化エンジン
    const initPrefetch = () => {
      const images = Array.from(document.querySelectorAll('img'));
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const index = images.indexOf(entry.target);
            // 現在の画像から5枚先までを裏で読み込み開始
            for (let i = 1; i <= 5; i++) {
              const nextImg = images[index + i];
              if (nextImg && nextImg.dataset.src && !nextImg.src) {
                nextImg.src = nextImg.dataset.src;
                nextImg.removeAttribute('loading'); // 遅延を解除
              }
            }
          }
        });
      }, { rootMargin: '3000px 0px' }); // 1000px先まで検知範囲を広げる

      images.forEach(img => {
        if (img.dataset.src) observer.observe(img);
        // 初期表示範囲にある画像は即ロード
        if (img.getBoundingClientRect().top < window.innerHeight + 1000 && img.dataset.src) {
          img.src = img.dataset.src;
        }
      });
    };
    
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initPrefetch);
    } else {
      initPrefetch();
    }
  })();
</script>
`;

// ==========================================
// 3. 故障検知（Failover）リトライ機能
// ==========================================
async function fetchWithRetry(req, targetUrlPath, attempt = 0) {
    if (attempt >= CF_WORKER_URLS.length) throw new Error("All Workers Offline");

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
            timeout: 15000 // 1台15秒で見切りをつける
        });

        if (response.status === 1101 || response.status >= 500) {
            console.warn(`[Failover] Worker ${currentWorker} failed. Retrying...`);
            return fetchWithRetry(req, targetUrlPath, attempt + 1);
        }
        return response;
    } catch (err) {
        return fetchWithRetry(req, targetUrlPath, attempt + 1);
    }
}

// ==========================================
// 4. メインプロキシ
// ==========================================
app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    try {
        const response = await fetchWithRetry(req, req.url);
        globalIndex = (globalIndex + 1) % CF_WORKER_URLS.length;

        // 不要ヘッダー削除
        response.headers.forEach((v, k) => {
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options'].includes(k.toLowerCase())) {
                res.set(k, v);
            }
        });

        const contentType = response.headers.get("content-type") || "";

        // HTMLの場合：広告削除 ＆ 究極コード注入
        if (contentType.includes("text/html")) {
            let text = await response.text();
            
            // 物理削除
            text = text.replace(/<script[^>]*universityshocksooner\.com[^>]*><\/script>/gi, "");
            text = text.replace(/<script[^>]*adexchangerapid\.com[^>]*><\/script>/gi, "");
            text = text.replace(/<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, "");
            text = text.split("universityshocksooner.com").join("localhost");

            // 注入
            text = text.replace('<head>', '<head>' + INJECT_CODE);

            res.set("Content-Type", "text/html; charset=utf-8");
            return res.status(response.status).send(text);
        }

        // 画像などはキャッシュを効かせてストリーミング
        if (req.url.includes('_p_') || contentType.includes("image")) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
        }

        res.status(response.status);
        response.body.pipe(res);

    } catch (error) {
        if (!res.headersSent) res.status(502).send("Proxy Node Error: All backend nodes are down.");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ultimate Manga Engine Online on port ${PORT}`));
