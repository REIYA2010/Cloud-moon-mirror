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

// 通信エージェント：大量の画像読み込みを高速化・安定化
const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 512,
    maxFreeSockets: 128,
    timeout: 90000,
    scheduling: 'lifo'
});

// ボディ解析リミット
app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ==========================================
// 2. 注入：広告抹殺 ＆ クリック保護 ＆ 先読みエンジン
// ==========================================
const INJECT_CODE = `
<style>
  /* 1. 広告・不要要素をCSSで強制非表示 */
  iframe, .pop--excl, .bg-ssp-11557, [id*="bg-ssp"], [class*="ad-"], #toast,
  [style*="z-index: 2147483647"], [style*="z-index: 9999"], 
  a[href*="adexchangerapid"], a[href*="university"] { 
    display: none !important; visibility: hidden !important; pointer-events: none !important; 
  }
  /* 続きを読むボタンを保護 */
  #load-more-chapters, .load-more, .read-more { 
    display: block !important; visibility: visible !important; opacity: 1 !important;
    background: #3b82f6 !important; color: white !important; border-radius: 8px;
  }
</style>
<script>
  (function() {
    // 2. window.open (ポップアップ) を完全に無効化
    window.open = function() { return { focus: function(){} }; };

    // 3. 【新機能】クリックリスナーの保護（キャプチャリング）
    // 広告スクリプトが反応する前にクリックイベントを横取りし、広告への遷移を止める
    window.addEventListener('click', function(e) {
      const target = e.target.closest('a');
      if (target) {
        const href = target.getAttribute('href') || "";
        if (href.includes('adex') || href.includes('university') || href.includes('link-center')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return false;
        }
        // 本来のボタンや漫画へのクリックはそのまま通すが、広告スクリプトには伝播させない
        e.stopImmediatePropagation();
      }
    }, true); 

    // 4. 透明ボタン監視・破壊エンジン（1秒おき）
    const nukeOverlays = () => {
      document.querySelectorAll('div, a, section, ins').forEach(el => {
        const s = window.getComputedStyle(el);
        const z = parseInt(s.zIndex);
        // z-indexが高い透明な板を即削除
        if (z > 1000 && (parseFloat(s.opacity) < 0.1 || s.backgroundColor.includes('rgba(0, 0, 0, 0)'))) {
          if (!el.innerText.trim()) el.remove();
        }
      });
    };
    setInterval(nukeOverlays, 1000);

    // 5. 5枚先読み・スクロール最適化エンジン
    const initPrefetch = () => {
      const images = Array.from(document.querySelectorAll('img'));
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const idx = images.indexOf(entry.target);
            for (let i = 1; i <= 5; i++) {
              const nextImg = images[idx + i];
              if (nextImg && nextImg.dataset.src && !nextImg.src) {
                nextImg.src = nextImg.dataset.src;
                nextImg.removeAttribute('loading');
              }
            }
          }
        });
      }, { rootMargin: '1000px' });
      images.forEach(img => { if (img.dataset.src) observer.observe(img); });
    };
    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', initPrefetch) : initPrefetch();
  })();
</script>
`;

// ==========================================
// 3. 故障検知（Failover）リトライ機能
// ==========================================
async function fetchWithRetry(req, targetUrlPath, attempt = 0) {
    if (attempt >= CF_WORKER_URLS.length) throw new Error("All Backend Nodes Down");

    const currentWorker = CF_WORKER_URLS[(globalIndex + attempt) % CF_WORKER_URLS.length];
    const targetUrl = currentWorker + targetUrlPath;

    // ヘッダー整理
    const h = { ...req.headers };
    delete h.host; delete h.connection; delete h['content-length']; delete h['content-encoding'];
    h['X-Forwarded-Host'] = req.get('host');
    h['X-Forwarded-Proto'] = 'https';
    h['accept-encoding'] = 'identity'; // 圧縮させない

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: h,
            agent: proxyAgent,
            compress: true, 
            redirect: 'follow',
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined,
            timeout: 15000 
        });

        // 1101エラーや500系が出たら別のWorkerでリトライ
        if (response.status === 1101 || (response.status >= 500 && response.status <= 504)) {
            return fetchWithRetry(req, targetUrlPath, attempt + 1);
        }
        return response;
    } catch (err) {
        return fetchWithRetry(req, targetUrlPath, attempt + 1);
    }
}

// ==========================================
// 4. メインプロキシルーティング
// ==========================================
app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    try {
        const response = await fetchWithRetry(req, req.url);
        // 成功したら次のリクエストのためにインデックスを1つ進める
        globalIndex = (globalIndex + 1) % CF_WORKER_URLS.length;

        // レスポンスヘッダーの設定（Content-Length削除が重要）
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options'].includes(key)) {
                res.set(k, v);
            }
        });

        const contentType = response.headers.get("content-type") || "";

        // --- HTMLの場合：広告を物理検閲 ＆ コード注入 ---
        if (contentType.includes("text/html")) {
            let text = await response.text();

            // 物理削除1: すべてのonclick属性を剥奪（クリック爆弾解除）
            text = text.replace(/onclick=".*?"/gi, 'data-removed-click=""');
            
            // 物理削除2: 悪質ドメインのコードを消去
            const badDomains = ['universityshocksooner.com', 'adexchangerapid.com', 'gomuraw.js', 'platform.pubadx.one'];
            badDomains.forEach(d => {
                const re = new RegExp('<script[^>]*' + d.replace('.', '\\.') + '[^>]*><\\/script>', 'gi');
                text = text.replace(re, "");
                text = text.split(d).join("localhost");
            });

            // 物理削除3: 末尾の広告リンクを消去
            text = text.replace(/<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, "");

            // 保護コード注入 ＆ 文字化け強制防止
            text = text.replace('<head>', '<head>' + INJECT_CODE);
            res.set("Content-Type", "text/html; charset=utf-8");
            
            return res.status(response.status).send(text);
        }

        // --- 画像・アセットの場合：高速ストリーミング ---
        if (req.url.includes('_p_') || req.url.includes('_img_proxy_') || contentType.includes("image")) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
            res.set('Access-Control-Allow-Origin', '*');
        }

        res.status(response.status);
        response.body.pipe(res);

        response.body.on('error', () => res.end());

    } catch (error) {
        if (!res.headersSent) res.status(502).send("Service Unavailable");
    }
});

// ポート起動 (Render用)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ultimate Proxy System Online`));

// Vercel互換用エクスポート
module.exports = app;
