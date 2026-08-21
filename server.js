const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const iconv = require('iconv-lite');
const zstd = require('@mongodb-js/zstd');
const app = express();

// ==========================================
// 1. 設定：Cloudflare Workers クラスター
// ==========================================
const WORKER_CONFIGS = [
    "https://api-nemu.myproxy0108.workers.dev",
    "https://mangarw-api.72016.workers.dev",
    "https://tuneninemui.nemu0001.workers.dev"
];

const workers = WORKER_CONFIGS.map(url => ({
    url: url.replace(/\/$/, ''),
    isAlive: true,
    failCount: 0
}));

let rrIndex = 0;

function getActiveWorker() {
    const active = workers.filter(w => w.isAlive);
    if (active.length === 0) {
        console.warn('⚠️ ALL WORKERS DOWN! Emergency resetting pool...');
        workers.forEach(w => { w.isAlive = true; w.failCount = 0; });
        return workers[0];
    }
    return active[rrIndex++ % active.length];
}

function markWorkerFailure(worker) {
    worker.failCount++;
    console.warn(`⚠️ Worker [${worker.url}] failed (${worker.failCount}/3)`);
    if (worker.failCount >= 3) {
        worker.isAlive = false;
        console.error(`🚨 Worker [${worker.url}] IS ISOLATED due to failures!`);
    }
}

function markWorkerSuccess(worker) {
    worker.failCount = 0;
    worker.isAlive = true;
}

const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 600,
    timeout: 60000
});

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
            } catch (e) {}
        }
    }
}, 30000);

app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ==========================================
// 2. 広告ブロック用 ＋ 画像強制読み込み
// ==========================================
const INJECT_CODE = `
<style>
  iframe, .pop--excl, .bg-ssp-11557, [id*="bg-ssp"], [class*="ad-"], 
  [style*="2147483647"], [style*="9999"], #toast { 
    display: none !important; visibility: hidden !important; pointer-events: none !important; 
  }
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

    // ★★★ 画像を強制的に読み込む（このサイト専用） ★★★
    function forceLoadImages() {
      // すべての img タグを取得
      const images = document.querySelectorAll('img');
      images.forEach(img => {
        // 1. data-src があれば src にセット
        const dataSrc = img.getAttribute('data-src');
        if (dataSrc && !img.src) {
          img.src = dataSrc;
          console.log('🔵 Loaded image from data-src:', dataSrc);
        }

        // 2. data-lazy があれば src にセット
        const dataLazy = img.getAttribute('data-lazy');
        if (dataLazy && !img.src) {
          img.src = dataLazy;
          console.log('🔵 Loaded image from data-lazy:', dataLazy);
        }

        // 3. data-original があれば src にセット
        const dataOriginal = img.getAttribute('data-original');
        if (dataOriginal && !img.src) {
          img.src = dataOriginal;
          console.log('🔵 Loaded image from data-original:', dataOriginal);
        }

        // 4. lazy: から始まる属性があれば、そこからURLを抽出（このサイト専用）
        for (let attr of img.attributes) {
          if (attr.name.startsWith('lazy:')) {
            // 属性値にURLが含まれているかチェック
            const value = attr.value;
            const urlMatch = value.match(/(https?:\\/\\/[^\\s"']+)/);
            if (urlMatch && !img.src) {
              img.src = urlMatch[1];
              console.log('🔵 Loaded image from lazy attribute:', urlMatch[1]);
            }
          }
        }

        // 5. 画像が読み込まれていない場合、背景画像として設定されている可能性をチェック
        if (!img.src) {
          const style = img.getAttribute('style') || '';
          const bgMatch = style.match(/url\\(['"]?([^'")]+)['"]?\\)/);
          if (bgMatch) {
            // 背景画像を img の src として設定
            img.src = bgMatch[1];
            console.log('🔵 Loaded image from background-image:', bgMatch[1]);
          }
        }
      });

      // picture タグ内の source タグにも対応
      document.querySelectorAll('source[data-srcset]').forEach(source => {
        const dataSrcset = source.getAttribute('data-srcset');
        if (dataSrcset) {
          source.srcset = dataSrcset;
        }
      });
    }

    // DOM読み込み時に実行
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', forceLoadImages);
    } else {
      forceLoadImages();
    }

    // 動的に追加される画像にも対応（MutationObserver）
    const observer = new MutationObserver(() => {
      forceLoadImages();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // スクロール時にも再実行（遅延読み込み対策）
    let scrollTimer;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(forceLoadImages, 300);
    });

    // 3秒後にももう一度実行（保険）
    setTimeout(forceLoadImages, 3000);
    setTimeout(forceLoadImages, 5000);

    console.log('🟢 Image force-load script injected successfully');
  })();
</script>
`;

// ==========================================
// 3. メインプロキシ（全リソースで zstd 解凍対応）
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
                redirect: 'follow',
                timeout: 12000,
                body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined
            });

            console.log(`🔍 Request: ${req.method} ${req.url} -> ${targetUrl}`);
            console.log(`🔍 Response status: ${response.status}`);
            console.log(`🔍 Content-Encoding: ${response.headers.get('content-encoding') || 'none'}`);

            if (response.status >= 500) {
                console.warn(`⚠️ Worker [${worker.url}] returned HTTP ${response.status}. Retrying...`);
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
            let buffer = await response.buffer();

            // zstd 圧縮されていたら解凍
            const contentEncoding = response.headers.get('content-encoding');
            if (contentEncoding && contentEncoding.includes('zstd')) {
                try {
                    buffer = await zstd.decompress(buffer);
                    console.log(`✅ Decompressed zstd: ${req.url}`);
                    res.removeHeader('content-encoding');
                } catch (e) {
                    console.warn(`⚠️ zstd decompression failed for ${req.url}:`, e.message);
                }
            }

            // --- HTML の場合：広告ブロックを注入 ---
            if (contentType.includes("text/html")) {
                let charset = 'utf-8';
                const charsetMatch = contentType.match(/charset=([^;]+)/);
                if (charsetMatch) {
                    charset = charsetMatch[1].toLowerCase();
                } else {
                    charset = 'shift_jis';
                }

                let text = iconv.decode(buffer, charset);

                if (charset === 'utf-8' && /[\uFFFD�]/.test(text)) {
                    console.warn('⚠️ UTF-8 decode broken, retrying Shift-JIS');
                    text = iconv.decode(buffer, 'shift_jis');
                    charset = 'shift_jis';
                }

                text = text.replace('<head>', '<head>' + INJECT_CODE);
                res.set("Content-Type", `text/html; charset=${charset}`);
                return res.status(response.status).send(text);
            }

            // --- 画像・CSS・JS など ---
            if (contentType.includes('image') || contentType.includes('font') || contentType.includes('application/octet-stream')) {
                res.set('Content-Type', contentType);
                return res.status(response.status).send(buffer);
            }

            if (contentType.includes('text') || contentType.includes('javascript') || contentType.includes('json')) {
                const text = buffer.toString('utf-8');
                res.set('Content-Type', contentType);
                return res.status(response.status).send(text);
            }

            res.set('Content-Type', contentType);
            return res.status(response.status).send(buffer);

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
