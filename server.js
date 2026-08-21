const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const app = express();

// ==========================================
// 1. 設定：Cloudflare Workers クラスター
// ==========================================
const WORKER_CONFIGS = [
    "https://api-nemu.myproxy0108.workers.dev",
    "https://mangarw-api.72016.workers.dev",
    "https://tuneninemui.nemu0001.workers.dev"
];

// Workerの状態管理プール
const workers = WORKER_CONFIGS.map(url => ({
    url: url.replace(/\/$/, ''),
    isAlive: true,
    failCount: 0
}));

let rrIndex = 0;

// 【ヘルパー】生存している Worker をラウンドロビンで1つ選出
function getActiveWorker() {
    const active = workers.filter(w => w.isAlive);
    if (active.length === 0) {
        console.warn('⚠️ ALL WORKERS DOWN! Emergency resetting pool...');
        workers.forEach(w => { w.isAlive = true; w.failCount = 0; });
        return workers[0];
    }
    return active[rrIndex++ % active.length];
}

// 障害判定
function markWorkerFailure(worker) {
    worker.failCount++;
    console.warn(`⚠️ Worker [${worker.url}] failed (${worker.failCount}/3)`);
    if (worker.failCount >= 3) {
        worker.isAlive = false;
        console.error(`🚨 Worker [${worker.url}] IS ISOLATED due to failures!`);
    }
}

// 正常復帰
function markWorkerSuccess(worker) {
    worker.failCount = 0;
    worker.isAlive = true;
}

// ★ 通信安定化エージェントを先に定義（setInterval より前に移動）★
const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 600,
    timeout: 60000
});

// 【バックグラウンドヘルスチェック】障害Workerの自動復帰診断（30秒周期）
setInterval(async () => {
    for (const w of workers) {
        if (!w.isAlive) {
            try {
                const res = await fetch(w.url + '/favicon.ico', {
                    method: 'GET',
                    agent: proxyAgent,
                    timeout: 5000
                });
                if (res.ok || res.status === 404 || res.status === 302) {
                    console.log(`✅ Worker [${w.url}] RECOVERED & BACK ALIVE!`);
                    markWorkerSuccess(w);
                }
            } catch (e) {
                // 復帰失敗時は静観
            }
        }
    }
}, 30000);

app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ==========================================
// 2. 広告抹殺パターン（★ 今回は使用しません ★）
// ==========================================
const AD_DOMAINS = [
    'universityshocksooner.com',
    'adexchangerapid.com',
    'platform.pubadx.one',
    'preferencenail.com',
    'gomuraw.js',
    'vntsm.com'
];

// ブラウザ内で動く強力な広告クリーナー（このまま有効）
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
// 3. メインプロキシロジック（自動リトライ機能付）
// ==========================================
app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    const maxRetries = workers.length;
    let attempt = 0;

    while (attempt < maxRetries) {
        attempt++;
        const worker = getActiveWorker();
        const targetUrl = worker.url + req.url;

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
                compress: false,                    // ★ 圧縮を無効化（文字化け対策）★
                redirect: 'follow',
                timeout: 12000,
                body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined
            });

            if (response.status >= 500) {
                console.warn(`⚠️ Worker [${worker.url}] returned HTTP ${response.status}. Retrying another worker...`);
                markWorkerFailure(worker);
                continue;
            }

            markWorkerSuccess(worker);

            response.headers.forEach((v, k) => {
                if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy'].includes(k.toLowerCase())) {
                    res.set(k, v);
                }
            });

            const contentType = response.headers.get("content-type") || "";

            // --- HTMLの場合 ---
            if (contentType.includes("text/html")) {
                let text = await response.text();

                // ★★★ 広告置換を完全に無効化（画像URL破壊を防止）★★★
                /*
                AD_DOMAINS.forEach(domain => {
                    const regex = new RegExp('<script[^>]*' + domain.replace('.', '\\.') + '[^>]*><\\/script>', 'gi');
                    text = text.replace(regex, "");
                    text = text.split(domain).join("localhost");
                });
                text = text.replace(/<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, "");
                */

                // 広告ブロック用JS/CSSは注入（ブラウザ側で頑張ってもらう）
                text = text.replace('<head>', '<head>' + INJECT_CODE);

                // ★ charsetを元のHTMLのものに維持（UTF-8強制をやめる）★
                const charsetMatch = contentType.match(/charset=([^;]+)/);
                const charset = charsetMatch ? charsetMatch[1] : 'utf-8';
                res.set("Content-Type", `text/html; charset=${charset}`);

                return res.status(response.status).send(text);
            }

            // --- 画像・JS・CSSの場合：ストリーミング ---
            if (req.url.includes('_p_')) {
                res.set('Cache-Control', 'public, max-age=31536000, immutable');
            }
            res.status(response.status);
            return response.body.pipe(res);

        } catch (error) {
            console.error(`Attempt ${attempt} failed on [${worker.url}]:`, error.message);
            markWorkerFailure(worker);
        }
    }

    console.error('Fatal Error: All Workers failed.');
    if (!res.headersSent) {
        res.status(502).send("Proxy Service Unavailable (All workers unreachable)");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`--- ULTIMATE CLUSTER PROXY ENGINE ONLINE ---`));
