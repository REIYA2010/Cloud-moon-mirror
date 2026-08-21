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
// 2. 画像プロキシエンドポイント（修正済み）
// ==========================================
app.get('/proxy', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) {
        return res.status(400).send('Missing url parameter');
    }

    let url = decodeURIComponent(rawUrl);

    // もし _img_proxy_ が含まれていたら、正しいCDN URLを抽出
    if (url.includes('_img_proxy_')) {
        const match = url.match(/https?:\/\/[^\/]+\.com[^"']+/);
        if (match) {
            url = match[0];
        } else {
            // それでもダメなら cdn.mangaraw123.com を探す
            const cdnMatch = url.match(/cdn\.mangaraw123\.com[^"'\s]+/);
            if (cdnMatch) {
                url = 'https://' + cdnMatch[0];
            }
        }
    }

    console.log(`🖼️ Proxy fetching: ${url}`);

    try {
        const response = await fetch(url, {
            agent: proxyAgent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
        });

        if (!response.ok) {
            console.warn(`⚠️ Proxy fetch failed: ${response.status} for ${url}`);
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
// 3. 広告ブロック用 ＋ 画像強制読み込み（最終修正版）
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

    function getImageUrlFromDataAttribute(value) {
      // カンマ区切りの場合は分割
      if (value.includes(',')) {
        const parts = value.split(',').map(s => s.trim());
        // 最初の部分が完全なURL（プロトコル付き）ならそれを優先
        for (let part of parts) {
          if (part.startsWith('http://') || part.startsWith('https://')) {
            // ただし自分自身のドメインは除外（ループ防止）
            if (!part.includes(window.location.hostname)) {
              return part;
            }
          }
        }
        // それ以外なら cdn.mangaraw123.com を含む部分を探す
        for (let part of parts) {
          if (part.includes('cdn.mangaraw123.com')) {
            // プロトコルがなければ https:// を付ける
            if (part.startsWith('cdn.mangaraw123.com')) {
              return 'https://' + part;
            }
            return part;
          }
        }
        // どれもダメなら最初の部分（ただし自分のホストは避ける）
        for (let part of parts) {
          if (!part.includes(window.location.hostname)) {
            return part;
          }
        }
        // やむを得ず最初の部分を使う
        return parts[0];
      } else {
        // カンマがない場合：そのまま使うが、自分のホストは除外
        if (value.includes(window.location.hostname)) {
          // 自分自身へのリンクなら、_img_proxy_ を除去して CDN URL を抽出
          const cdnMatch = value.match(/cdn\.mangaraw123\.com[^"'\s]+/);
          if (cdnMatch) {
            return 'https://' + cdnMatch[0];
          }
          return null;
        }
        return value;
      }
    }

    function forceLoadImages() {
      try {
        const images = document.querySelectorAll('img');
        images.forEach(img => {
          // 既にプロキシ経由または読み込み済みはスキップ
          if (img.src && img.src.startsWith('/proxy')) return;
          if (img.complete && img.naturalWidth > 0) return;

          // 1. data-src / data-lazy / data-original から取得
          const dataSrc = img.getAttribute('data-src') || 
                          img.getAttribute('data-lazy') || 
                          img.getAttribute('data-original');
          if (dataSrc) {
            let url = getImageUrlFromDataAttribute(dataSrc);
            if (url) {
              // プロトコルがない場合は https:// を補完
              if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('/')) {
                url = 'https://' + url;
              }
              // 絶対URLならプロキシ経由に変換
              if (url.startsWith('http')) {
                img.src = '/proxy?url=' + encodeURIComponent(url);
              } else {
                img.src = url; // 相対パスはそのまま（プロキシが処理）
              }
              console.log('🔵 Loaded from data attribute:', url);
              return;
            }
          }

          // 2. lazy: 属性からURLを抽出
          for (let attr of img.attributes) {
            if (attr.name.startsWith('lazy:')) {
              const urlMatch = attr.value.match(/(https?:\\/\\/[^\\s"']+)/);
              if (urlMatch) {
                img.src = '/proxy?url=' + encodeURIComponent(urlMatch[1]);
                console.log('🔵 Loaded from lazy attribute:', urlMatch[1]);
                return;
              }
            }
          }

          // 3. srcset から取得（srcが空の場合）
          if (!img.src && img.srcset) {
            const firstSrc = img.srcset.split(',')[0].trim().split(' ')[0];
            if (firstSrc) {
              img.src = '/proxy?url=' + encodeURIComponent(firstSrc);
              console.log('🔵 Loaded from srcset:', firstSrc);
              return;
            }
          }

          // 4. 既存のsrcが絶対URLならプロキシ経由に書き換え
          if (img.src && img.src.startsWith('http') && !img.src.startsWith('/proxy')) {
            const originalSrc = img.src;
            img.src = '/proxy?url=' + encodeURIComponent(originalSrc);
            console.log('🔵 Rewrote absolute URL to proxy:', originalSrc);
          }
        });
      } catch(e) {
        console.warn('⚠️ forceLoadImages error:', e.message);
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(forceLoadImages, 500));
    } else {
      setTimeout(forceLoadImages, 500);
    }

    try {
      if (document.body) {
        const observer = new MutationObserver(() => setTimeout(forceLoadImages, 300));
        observer.observe(document.body, { childList: true, subtree: true });
        console.log('🟢 MutationObserver started');
      }
    } catch(e) {
      console.warn('⚠️ MutationObserver setup failed:', e.message);
    }

    let scrollTimer;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(forceLoadImages, 400);
    });

    setInterval(forceLoadImages, 5000);
    console.log('🟢 Image force-load script injected');
  })();
</script>
`;

// ==========================================
// 4. メインプロキシ
// ==========================================
app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();
    if (req.url.startsWith('/proxy')) return; // プロキシエンドポイントは別途処理済み

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

                // ★ 画像URL（src）のみプロキシ経由に書き換え（data-srcは変更しない） ★
                text = text.replace(/src="(https?:\/\/[^"]+)"/g, (match, url) => {
                    if (url.includes(req.get('host'))) return match;
                    return `src="/proxy?url=${encodeURIComponent(url)}"`;
                });
                // data-src はそのまま残す（ブラウザ側で処理）

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
