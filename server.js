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

    if (url.includes('cdn.mangaraw123.com')) {
        const fileMatch = url.match(/([^\/]+\.(jpg|jpeg|png|webp|gif|bmp|svg))/i);
        if (fileMatch) {
            const fileName = fileMatch[1];
            const worker = getActiveWorker();
            const workerUrl = worker.url + '/_img_proxy/_cdn.mangaraw123.com/covers/' + fileName;
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
// 3. 広告ブロック用
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

                // ★★★ 画像URLを強制書き換え（絶対URL + 相対パス） ★★★

                // 1. _img_proxy/_cdn.mangaraw123.com/covers/xxx.jpg を /proxy?url=... に変換（Worker経由）
                text = text.replace(/_img_proxy\/_cdn\.mangaraw123\.com\/covers\/([^"'\s]+)/g, (match, fileName) => {
                    const proxyUrl = `/proxy?url=${encodeURIComponent('https://cdn.mangaraw123.com/covers/' + fileName)}`;
                    console.log(`🔵 Server rewrote Worker path: ${fileName} -> ${proxyUrl}`);
                    return proxyUrl;
                });

                // 2. src="https://cdn.mangaraw123.com/covers/xxx.jpg" を変換
                text = text.replace(/src="https?:\/\/cdn\.mangaraw123\.com\/covers\/([^"]+)"/g, (match, fileName) => {
                    const proxyUrl = `/proxy?url=${encodeURIComponent('https://cdn.mangaraw123.com/covers/' + fileName)}`;
                    return `src="${proxyUrl}"`;
                });

                // 3. ★★★ 相対パスの画像（例：src="rimo-torabuho-ru.jpg"）を Worker 経由に変換 ★★★
                text = text.replace(/<img([^>]*)src="([^"/\\s]+\.(jpg|jpeg|png|webp|gif|bmp|svg))"([^>]*)>/gi, (match, before, fileName, ext, after) => {
                    // 既にプロキシ経由や絶対URL、data:スキームの場合はスキップ
                    if (fileName.startsWith('/') || fileName.startsWith('http') || fileName.startsWith('data:')) return match;
                    // すでに変換済みの場合はスキップ
                    if (before.includes('/proxy') || after.includes('/proxy')) return match;
                    const workerPath = `/_img_proxy/_cdn.mangaraw123.com/covers/${fileName}`;
                    console.log(`🔵 Server rewrote relative image: ${fileName} -> ${workerPath}`);
                    return `<img${before}src="${workerPath}"${after}>`;
                });

                // 4. data-src の相対パスも変換
                text = text.replace(/<img([^>]*)data-src="([^"/\\s]+\.(jpg|jpeg|png|webp|gif|bmp|svg))"([^>]*)>/gi, (match, before, fileName, ext, after) => {
                    if (fileName.startsWith('/') || fileName.startsWith('http') || fileName.startsWith('data:')) return match;
                    if (before.includes('/proxy') || after.includes('/proxy')) return match;
                    const workerPath = `/_img_proxy/_cdn.mangaraw123.com/covers/${fileName}`;
                    return `<img${before}data-src="${workerPath}"${after}>`;
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
