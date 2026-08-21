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
// 2. 広告ブロック用（簡素化）
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
    console.log('🟢 Ad-block script injected');
  })();
</script>
`;

// ==========================================
// 3. 画像プロキシ（/_img_proxy/ ルートを処理）
// ==========================================
app.get('/_img_proxy/*', async (req, res) => {
    try {
        const fullPath = req.params[0];
        const fileMatch = fullPath.match(/\/covers\/([^\/]+)$/);
        if (fileMatch) {
            const fileName = fileMatch[1];
            const worker = getActiveWorker();
            const workerUrl = worker.url + '/_img_proxy/_cdn.mangaraw123.com/covers/' + fileName;
            console.log(`🖼️ Image proxy: ${req.url} -> ${workerUrl}`);
            const response = await fetch(workerUrl, {
                agent: proxyAgent,
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 15000
            });
            if (!response.ok) {
                return res.status(response.status).send('Image not found');
            }
            const buffer = await response.buffer();
            const contentType = response.headers.get('content-type') || 'image/jpeg';
            res.set('Content-Type', contentType);
            res.set('Cache-Control', 'public, max-age=86400');
            return res.send(buffer);
        }
        res.status(404).send('Image not found');
    } catch (e) {
        console.error(`Image proxy error: ${e.message}`);
        res.status(500).send('Image proxy error');
    }
});

// ==========================================
// 4. メインプロキシ（HTML書き換えを強化）
// ==========================================
app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();
    if (req.url.startsWith('/_img_proxy/')) return;

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

                // ★★★ 強力かつ網羅的な画像URL書き換え ★★★
                // ファイル名（拡張子付き）を抽出する関数（カンマ区切り対応）
                function extractFileName(value) {
                    if (!value) return null;
                    // カンマで分割して各部分をチェック
                    const parts = value.split(',').map(s => s.trim());
                    for (let part of parts) {
                        // 拡張子を含むファイル名を抽出（クエリパラメータを無視）
                        const match = part.match(/([^\/\\s"']+\.(jpg|jpeg|png|webp|gif|bmp|svg))(?:\?|$)/i);
                        if (match) return match[1];
                    }
                    // カンマがない場合は直接抽出
                    const match = value.match(/([^\/\\s"']+\.(jpg|jpeg|png|webp|gif|bmp|svg))(?:\?|$)/i);
                    return match ? match[1] : null;
                }

                // 絶対パスを生成（先頭スラッシュ必須）
                function makeAbsolutePath(fileName) {
                    return '/' + '_img_proxy/_cdn.mangaraw123.com/covers/' + fileName;
                }

                // 1. すべての img タグの src 属性を書き換え
                text = text.replace(/<img([^>]*)src=["']([^"']*)["']([^>]*)>/gi, (match, before, srcVal, after) => {
                    if (!srcVal || srcVal.startsWith('data:') || srcVal.startsWith('/_img_proxy/')) return match;
                    const fileName = extractFileName(srcVal);
                    if (fileName) {
                        const newSrc = makeAbsolutePath(fileName);
                        console.log(`🔵 src rewrite: ${srcVal} -> ${newSrc}`);
                        return `<img${before}src="${newSrc}"${after}>`;
                    }
                    return match;
                });

                // 2. data-src / data-lazy / data-original / data-srcset を書き換え
                const lazyAttrs = ['data-src', 'data-lazy', 'data-original', 'data-srcset'];
                for (const attr of lazyAttrs) {
                    const regex = new RegExp(`<img([^>]*)${attr}=["']([^"']*)["']([^>]*)>`, 'gi');
                    text = text.replace(regex, (match, before, attrVal, after) => {
                        if (!attrVal || attrVal.startsWith('data:') || attrVal.startsWith('/_img_proxy/')) return match;
                        const fileName = extractFileName(attrVal);
                        if (fileName) {
                            const newVal = makeAbsolutePath(fileName);
                            console.log(`🔵 ${attr} rewrite: ${attrVal} -> ${newVal}`);
                            return `<img${before}${attr}="${newVal}"${after}>`;
                        }
                        return match;
                    });
                }

                // 3. 先頭スラッシュがない Worker パスを修正（_img_proxy/... を /_img_proxy/... に）
                text = text.replace(/["']_img_proxy\/_cdn\.mangaraw123\.com\/covers\/([^"']+)["']/g, (match, fileName) => {
                    const newSrc = makeAbsolutePath(fileName);
                    console.log(`🔵 Fix missing slash: ${match} -> "${newSrc}"`);
                    return `"${newSrc}"`;
                });

                // 4. プロトコルレスURL（//cdn...）を Worker パスに
                text = text.replace(/src=["']\/\/cdn\.mangaraw123\.com\/covers\/([^"']+)["']/g, (match, fileName) => {
                    const newSrc = makeAbsolutePath(fileName);
                    console.log(`🔵 Protocol-relative rewrite: ${match} -> src="${newSrc}"`);
                    return `src="${newSrc}"`;
                });

                // 5. 絶対URL（https://cdn...）を Worker パスに
                text = text.replace(/src=["']https?:\/\/cdn\.mangaraw123\.com\/covers\/([^"']+)["']/g, (match, fileName) => {
                    const newSrc = makeAbsolutePath(fileName);
                    console.log(`🔵 Absolute URL rewrite: ${match} -> src="${newSrc}"`);
                    return `src="${newSrc}"`;
                });

                // 6. さらに、data-src でも同様の絶対URL書き換え
                text = text.replace(/data-src=["']https?:\/\/cdn\.mangaraw123\.com\/covers\/([^"']+)["']/g, (match, fileName) => {
                    const newSrc = makeAbsolutePath(fileName);
                    console.log(`🔵 data-src absolute rewrite: ${match} -> data-src="${newSrc}"`);
                    return `data-src="${newSrc}"`;
                });

                // 広告ブロック注入
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
