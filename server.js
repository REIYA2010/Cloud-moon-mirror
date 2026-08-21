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
// 2. 画像プロキシエンドポイント
// ==========================================
app.get('/proxy', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) {
        return res.status(400).send('Missing url parameter');
    }

    let url = decodeURIComponent(rawUrl);

    // もし _img_proxy_ が含まれていたら、正しいCDN URLを抽出
    if (url.includes('_img_proxy_')) {
        const cdnMatch = url.match(/cdn\.mangaraw123\.com[^"'\s]+/);
        if (cdnMatch) {
            url = 'https://' + cdnMatch[0];
        }
    }

    // もし自分のホストが含まれていたら除去
    if (url.includes('mangarw-production-b003.up.railway.app')) {
        const cdnMatch = url.match(/cdn\.mangaraw123\.com[^"'\s]+/);
        if (cdnMatch) {
            url = 'https://' + cdnMatch[0];
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

    // ★★★ 完全に書き直した画像抽出関数 ★★★
    function extractCleanImageUrl(value) {
      if (!value) return null;

      // 1. カンマ区切りを処理
      if (value.includes(',')) {
        const parts = value.split(',').map(s => s.trim());
        for (let part of parts) {
          // cdn.mangaraw123.com を含む部分を探す（最優先）
          if (part.includes('cdn.mangaraw123.com')) {
            const match = part.match(/cdn\.mangaraw123\.com[^"'\s]+/);
            if (match) return 'https://' + match[0];
          }
          // 自分のドメインを含まず、httpで始まるものを探す
          if (!part.includes(window.location.hostname) && (part.startsWith('http://') || part.startsWith('https://'))) {
            return part;
          }
        }
        // 見つからなければ最初の部分を使う（ただし自分のドメインは除外）
        for (let part of parts) {
          if (!part.includes(window.location.hostname)) {
            return part;
          }
        }
        return null;
      }

      // 2. カンマがない場合
      // cdn.mangaraw123.com を含むかチェック
      if (value.includes('cdn.mangaraw123.com')) {
        const match = value.match(/cdn\.mangaraw123\.com[^"'\s]+/);
        if (match) return 'https://' + match[0];
      }

      // 自分のドメインなら除去して再抽出
      if (value.includes(window.location.hostname)) {
        const cdnMatch = value.match(/cdn\.mangaraw123\.com[^"'\s]+/);
        if (cdnMatch) return 'https://' + cdnMatch[0];
        return null;
      }

      // それ以外はそのまま返す
      if (value.startsWith('http://') || value.startsWith('https://')) {
        return value;
      }

      return null;
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
            const cleanUrl = extractCleanImageUrl(dataSrc);
            if (cleanUrl) {
              // 絶対URLならプロキシ経由に変換
              if (cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://')) {
                img.src = '/proxy?url=' + encodeURIComponent(cleanUrl);
              } else {
                img.src = cleanUrl;
              }
              console.log('🔵 Loaded from data attribute:', cleanUrl);
              return;
            }
          }

          // 2. lazy: 属性からURLを抽出
          for (let attr of img.attributes) {
            if (attr.name.startsWith('lazy:')) {
              const cleanUrl = extractCleanImageUrl(attr.value);
              if (cleanUrl) {
                img.src = '/proxy?url=' + encodeURIComponent(cleanUrl);
                console.log('🔵 Loaded from lazy attribute:', cleanUrl);
                return;
              }
            }
          }

          // 3. srcset から取得（srcが空の場合）
          if (!img.src && img.srcset) {
            const firstSrc = img.srcset.split(',')[0].trim().split(' ')[0];
            if (firstSrc) {
              const cleanUrl = extractCleanImageUrl(firstSrc);
              if (cleanUrl) {
                img.src = '/proxy?url=' + encodeURIComponent(cleanUrl);
                console.log('🔵 Loaded from srcset:', cleanUrl);
                return;
              }
            }
          }

          // 4. 既存のsrcが絶対URLならプロキシ経由に書き換え
          if (img.src && (img.src.startsWith('http://') || img.src.startsWith('https://')) && !img.src.startsWith('/proxy')) {
            const cleanUrl = extractCleanImageUrl(img.src);
            if (cleanUrl && cleanUrl !== img.src) {
              img.src = '/proxy?url=' + encodeURIComponent(cleanUrl);
              console.log('🔵 Rewrote URL to proxy:', cleanUrl);
            } else if (cleanUrl) {
              img.src = '/proxy?url=' + encodeURIComponent(cleanUrl);
              console.log('🔵 Rewrote absolute URL to proxy:', cleanUrl);
            }
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

                // ★ 画像URL（src）のみプロキシ経由に書き換え ★
                text = text.replace(/src="(https?:\/\/[^"]+)"/g, (match, url) => {
                    if (url.includes(req.get('host'))) return match;
                    // cdn.mangaraw123.com を含むならそのままプロキシ経由に
                    if (url.includes('cdn.mangaraw123.com')) {
                        return `src="/proxy?url=${encodeURIComponent(url)}"`;
                    }
                    return match;
                });

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
