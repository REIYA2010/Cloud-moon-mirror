const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const app = express();

const CF_WORKER_URLS = [
    "https://mangarw-api.myproxy0108.workers.dev",
    "https://api-nemu.myproxy0108.workers.dev",
    "https://sika-sika-manga.myproxy0108.workers.dev"
];
let workerIndex = 0;
const getWorker = () => CF_WORKER_URLS[workerIndex++ % CF_WORKER_URLS.length];

const proxyAgent = new https.Agent({ keepAlive: true, maxSockets: 256, timeout: 60000 });
app.use(express.raw({ type: '*/*', limit: '50mb' }));

// --- 広告削除エンジンの修正（ボタンを巻き込まないようにドメイン指定に限定） ---
const adBlockPatterns = [
    /https?:\/\/universityshocksooner\.com\/[^"'\s]+/gi,
    /https?:\/\/adexchangerapid\.com\/[^"'\s]+/gi,
    /https?:\/\/platform\.pubadx\.one\/[^"'\s]+/gi,
    /<script[^>]*universityshocksooner\.com[^>]*><\/script>/gi,
    /<script[^>]*adexchangerapid\.com[^>]*><\/script>/gi,
    /<script[^>]*gomuraw\.js[^>]*><\/script>/gi,
    /<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, // 末尾の隠しリンク
    /universityshocksooner\.com/gi
];

// --- 注入コードの修正（UIを壊さない安全な設定） ---
const adKillerCode = `
<style>
  /* 特定の既知の広告ID/クラスのみを隠す */
  iframe[src*="googleads"], iframe[src*="doubleclick"], 
  .pop--excl, .bg-ssp-11557, [id*="bg-ssp"],
  #initial-loader, #toast { 
    display: none !important; visibility: hidden !important; 
  }
  /* 続きを読むボタン（load-more-chapters）は絶対に消さないように強制表示 */
  #load-more-chapters, .load-more, .read-more {
    display: block !important; visibility: visible !important; opacity: 1 !important;
  }
</style>
<script>
  // 透明なオーバーレイのみを狙い撃ちして削除
  const killGhostAds = () => {
    document.querySelectorAll('div').forEach(el => {
      const s = window.getComputedStyle(el);
      // z-indexが異常に高く、中身が空っぽ、あるいは透明な板を削除
      if (parseInt(s.zIndex) > 10000 && s.opacity === '0' && el.innerText.length === 0) {
        el.remove();
      }
    });
  };
  setInterval(killGhostAds, 1000);
</script>
`;

app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();
    const selectedWorker = getWorker();
    const targetUrl = selectedWorker + req.url;

    const cleanHeaders = {};
    const skip = ['host', 'connection', 'content-length', 'content-encoding', 'cf-ray', 'cf-connecting-ip'];
    Object.keys(req.headers).forEach(k => { if(!skip.includes(k.toLowerCase())) cleanHeaders[k] = req.headers[k]; });
    cleanHeaders['X-Forwarded-Host'] = req.get('host');
    cleanHeaders['X-Forwarded-Proto'] = 'https';

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: cleanHeaders,
            agent: proxyAgent,
            compress: true, 
            redirect: 'follow',
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined
        });

        response.headers.forEach((v, k) => {
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options'].includes(k.toLowerCase())) {
                res.set(k, v);
            }
        });

        const contentType = response.headers.get("content-type") || "";

        // HTMLの時だけ広告除去を行う
        if (contentType.includes("text/html")) {
            let text = await response.text();
            adBlockPatterns.forEach(p => { text = text.replace(p, ""); });
            text = text.replace('<head>', '<head>' + adKillerCode);
            if (!contentType.includes("charset")) res.set("Content-Type", "text/html; charset=utf-8");
            return res.status(response.status).send(text);
        }

        // 画像などはストリーミング
        if (req.url.includes('_p_')) res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.status(response.status);
        response.body.pipe(res);

    } catch (error) {
        if (!res.headersSent) res.status(502).end();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT);
