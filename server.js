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
// 2. 画像プロキシエンドポイント（最終版）
// ==========================================
app.get('/proxy', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) {
        return res.status(400).send('Missing url parameter');
    }

    let url = decodeURIComponent(rawUrl);

    // ★ cdn.mangaraw123.com へのリクエストは Worker 経由で取得 ★
    if (url.includes('cdn.mangaraw123.com')) {
        const fileMatch = url.match(/([^\/]+\.(jpg|jpeg|png|webp|gif|bmp|svg))/i);
        if (fileMatch) {
            const fileName = fileMatch[1];
            const worker = getActiveWorker();
            const workerUrl = worker.url + '/_img_proxy_/cdn.mangaraw123.com/covers/' + fileName;
            console.log(`🖼️ Fetching via Worker: ${workerUrl}`);
            try {
                const response = await fetch(workerUrl, {
                    agent: proxyAgent,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: 15000
                });
                if (!response.ok) {
                    console.warn(`⚠️ Worker fetch failed: ${response.status} for ${workerUrl}`);
                    return res.status(response.status).send('Failed to fetch image');
                }
                const buffer = await response.buffer();
                const contentType = response.headers.get('content-type') || 'image/jpeg';
                res.set('Content-Type', contentType);
                res.set('Cache-Control', 'public, max-age=86400');
                return res.send(buffer);
            } catch (e) {
                console.error(`Worker proxy error for ${workerUrl}:`, e.message);
                return res.status(500).send('Failed to fetch image');
            }
        }
    }

    // 通常のプロキシ処理
    try {
        const response = await fetch(url, {
            agent: proxyAgent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
        });
        if (!response.ok) {
            return res.status(response.status).send('Failed to fetch image');
        }
        const buffer = await response.buffer();
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(buffer);
    } catch (e) {
        console.error(`Proxy error for ${url}:`, e.message);
        res.status(500).send('Failed to fetch image');
    }
});

// ==========================================
// 3. 広告ブロック用 ＋ 画像強制読み込み（最終版）
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
    window.open = function() { return null; };

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

    // ★★★ 画像抽出関数 ★★★
    function extractCleanImageUrl(value) {
      if (!value) return null;

      // ファイル名（拡張子付き）を優先的に抽出
      const fileMatch = value.match(/([^\/\\s"']+\\.(jpg|jpeg|png|webp|gif|bmp|svg))/i);
      if (fileMatch) {
        const fileName = fileMatch[1];
        return '/proxy?url=' + encodeURIComponent('https://cdn.mangaraw123.com/covers/' + fileName);
      }

      // カンマ区切りから有効な部分を抽出
      if (value.includes(',')) {
        const parts = value.split(',').map(s => s.trim());
        for (let part of parts) {
          const fileMatch2 = part.match(/([^\/]+\.(jpg|jpeg|png|webp|gif))/i);
          if (fileMatch2) {
            return '/proxy?url=' + encodeURIComponent('https://cdn.mangaraw123.com/covers/' + fileMatch2[1]);
          }
        }
      }

      return null;
    }

    // ★★★ 画像を強制的に読み込む（srcを事前にクリア） ★★★
    function forceLoadImages() {
      try {
        const images = document.querySelectorAll('img');
        images.forEach(img => {
          // すでにプロキシ経由で読み込み済みならスキップ
          if (img.src && img.src.startsWith('/proxy')) {
            // ただし、読み込みに失敗している場合は再試行
            if (!img.complete || img.naturalWidth === 0) {
              // 再読み込み
              const currentSrc = img.src;
              img.src = '';
              img.src = currentSrc;
            }
            return;
          }

          // 読み込み完了済みの画像はスキップ（ただし壊れている場合は再試行）
          if (img.complete && img.naturalWidth > 0) return;

          const dataSrc = img.getAttribute('data-src') || 
                          img.getAttribute('data-lazy') || 
                          img.getAttribute('data-original');
          if (dataSrc) {
            const cleanUrl = extractCleanImageUrl(dataSrc);
            if (cleanUrl) {
              // ★ src を一旦空にしてから設定（ブラウザのプリロードを抑制） ★
              img.removeAttribute('src');
              img.src = cleanUrl;
              console.log('🔵 Loaded from data attribute:', cleanUrl);
              return;
            }
          }

          for (let attr of img.attributes) {
            if (attr.name.startsWith('lazy:')) {
              const cleanUrl = extractCleanImageUrl(attr.value);
              if (cleanUrl) {
                img.removeAttribute('src');
                img.src = cleanUrl;
                console.log('🔵 Loaded from lazy attribute:', cleanUrl);
                return;
              }
            }
          }

          if (!img.src && img.srcset) {
            const firstSrc = img.srcset.split(',')[0].trim().split(' ')[0];
            if (firstSrc) {
              const cleanUrl = extractCleanImageUrl(firstSrc);
              if (cleanUrl) {
                img.removeAttribute('src');
                img.src = cleanUrl;
                console.log('🔵 Loaded from srcset:', cleanUrl);
                return;
              }
            }
          }

          if (img.src && (img.src.startsWith('http://') || img.src.startsWith('https://')) && !img.src.startsWith('/proxy')) {
            const cleanUrl = extractCleanImageUrl(img.src);
            if (cleanUrl) {
              img.removeAttribute('src');
              img.src = cleanUrl;
              console.log('🔵 Rewrote URL to proxy:', cleanUrl);
              return;
            }
          }

          // それでも src が相対パスなら削除（エラーを防ぐ）
          if (img.src && !img.src.startsWith('/') && !img.src.startsWith('http')) {
            img.removeAttribute('src');
          }
        });
      } catch(e) {
        console.warn('⚠️ forceLoadImages error:', e.message);
      }
    }

    // DOM読み込み時に実行（即座に）
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(forceLoadImages, 100));
    } else {
      setTimeout(forceLoadImages, 100);
    }

    // MutationObserver で動的追加に対応
    try {
      if (document.body) {
        const observer = new MutationObserver(() => setTimeout(forceLoadImages, 200));
        observer.observe(document.body, { childList: true, subtree: true });
        console.log('🟢 MutationObserver started');
      }
    } catch(e) {
      console.warn('⚠️ MutationObserver setup failed:', e.message);
    }

    // スクロール時にも再実行
    let scrollTimer;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(forceLoadImages, 300);
    });

    // 定期実行（保険）
    setInterval(forceLoadImages, 3000);
    console.log('🟢 Image force-load script injected');
  })();
</script>
`;

// ==========================================
// 4. メインプロキシ
// ==========================================
app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();
    if (req.url.startsWith('/proxy')) return;

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
