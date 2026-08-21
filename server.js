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
// 2. 広告ブロック用
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
    if (req.url.startsWith('/_img_proxy/')) return; // すでに別途処理

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

                // ★★★ 強力な画像URL書き換え（すべてのパターンを網羅） ★★★
                function extractFileNameFromUrl(url) {
                    if (!url) return null;
                    // カンマ区切り対応
                    const parts = url.split(',').map(s => s.trim());
                    for (let part of parts) {
                        // ファイル名（拡張子付き）を抽出
                        const match = part.match(/([^\/\\s"']+\.(jpg|jpeg|png|webp|gif|bmp|svg))/i);
                        if (match) return match[1];
                    }
                    // 直接マッチ
                    const match = url.match(/([^\/\\s"']+\.(jpg|jpeg|png|webp|gif|bmp|svg))/i);
                    return match ? match[1] : null;
                }

                // 1. すべての img タグの src 属性を書き換え
                text = text.replace(/<img([^>]*)src=["']([^"']*)["']([^>]*)>/gi, (match, before, srcVal, after) => {
                    // すでに正しい Worker パスならスキップ
                    if (srcVal.startsWith('/_img_proxy/')) return match;
                    // data: スキームや空の場合はスキップ
                    if (srcVal.startsWith('data:') || !srcVal) return match;
                    const fileName = extractFileNameFromUrl(srcVal);
                    if (fileName) {
                        const newSrc = `/_img_proxy/_cdn.mangaraw123.com/covers/${fileName}`;
                        console.log(`🔵 src rewrite: ${srcVal} -> ${newSrc}`);
                        return `<img${before}src="${newSrc}"${after}>`;
                    }
                    return match;
                });

                // 2. data-src / data-lazy / data-original なども同様に
                const lazyAttributes = ['data-src', 'data-lazy', 'data-original', 'data-srcset'];
                for (const attr of lazyAttributes) {
                    const regex = new RegExp(`<img([^>]*)${attr}=["']([^"']*)["']([^>]*)>`, 'gi');
                    text = text.replace(regex, (match, before, attrVal, after) => {
                        if (attrVal.startsWith('/_img_proxy/')) return match;
                        if (attrVal.startsWith('data:') || !attrVal) return match;
                        const fileName = extractFileNameFromUrl(attrVal);
                        if (fileName) {
                            const newVal = `/_img_proxy/_cdn.mangaraw123.com/covers/${fileName}`;
                            console.log(`🔵 ${attr} rewrite: ${attrVal} -> ${newVal}`);
                            return `<img${before}${attr}="${newVal}"${after}>`;
                        }
                        return match;
                    });
                }

                // 3. 既存の不正な Worker パスを正規化
                text = text.replace(/_img_proxy_?\/_?cdn\.mangaraw123\.com\/covers\/([^"'\s]+)/g, (match, fileName) => {
                    const newSrc = `/_img_proxy/_cdn.mangaraw123.com/covers/${fileName}`;
                    console.log(`🔵 Normalize: ${match} -> ${newSrc}`);
                    return newSrc;
                });

                // 4. プロトコルレスURL（//cdn.mangaraw123.com/...）を変換
                text = text.replace(/src=["']\/\/cdn\.mangaraw123\.com\/covers\/([^"']+)["']/g, (match, fileName) => {
                    const newSrc = `/_img_proxy/_cdn.mangaraw123.com/covers/${fileName}`;
                    console.log(`🔵 Protocol-relative rewrite: ${match} -> ${newSrc}`);
                    return `src="${newSrc}"`;
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
