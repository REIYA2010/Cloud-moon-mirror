const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const app = express();

const CF_WORKER_URLS = [
    "https://mangarw-api.72016.workers.dev",
    "https://api-nemu.myproxy0108.workers.dev"
];
let workerIndex = 0;
const getWorker = () => CF_WORKER_URLS[workerIndex++ % CF_WORKER_URLS.length];

const proxyAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

app.use(express.raw({ type: '*/*', limit: '50mb' }));

const INJECT_CODE = `
<style>
  iframe, .pop--excl, .bg-ssp-11557, [id*="bg-ssp"], [class*="ad-"], 
  [style*="z-index: 2147483647"], [style*="z-index: 9999"], #toast { display: none !important; }
  #load-more-chapters, .load-more { display: block !important; visibility: visible !important; background: #3b82f6 !important; color: #fff !important; padding: 12px !important; text-align: center; border-radius: 8px; margin: 15px auto; }
</style>
<script>
  (function() {
    window.open = () => null;
    const nuke = () => {
      document.querySelectorAll('div, a').forEach(el => {
        const s = window.getComputedStyle(el);
        if (parseInt(s.zIndex) > 1000 && s.opacity === '0') el.remove();
        if (el.href && (el.href.includes('adex') || el.href.includes('university'))) el.remove();
      });
    };
    setInterval(nuke, 2000);
    // 画像先読み
    const pre = () => {
      const imgs = Array.from(document.querySelectorAll('img[data-src]'));
      const obs = new IntersectionObserver((es) => {
        es.forEach(e => {
          if (e.isIntersecting) {
            const idx = imgs.indexOf(e.target);
            for(let i=1; i<=3; i++) if(imgs[idx+i]) imgs[idx+i].src = imgs[idx+i].dataset.src;
          }
        });
      }, { rootMargin: '500px' });
      imgs.forEach(img => obs.observe(img));
    };
    document.readyState === 'complete' ? pre() : window.addEventListener('load', pre);
  })();
</script>
`;

app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    const selectedWorker = getWorker();
    const targetUrl = selectedWorker + req.url;
    const currentHost = req.get('host');

    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    headers['X-Forwarded-Host'] = currentHost;
    headers['X-Forwarded-Proto'] = 'https';
    headers['accept-encoding'] = 'identity'; // 圧縮させない

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: headers,
            agent: proxyAgent,
            compress: true, 
            redirect: 'follow',
            timeout: 9000 // Vercelの10秒制限に合わせる
        });

        // 応答ヘッダーの同期
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options'].includes(key)) {
                res.set(k, v);
            }
        });

        const contentType = response.headers.get("content-type") || "";

        // --- 1. 重要：JS/CSS/画像などのアセットは一切加工せず即座に返す ---
        // ここで加工をするとVercelがタイムアウトし、画面が真っ黒になります
        if (!contentType.includes("text/html")) {
            const buffer = await response.buffer();
            res.set("Access-Control-Allow-Origin", "*");
            return res.status(response.status).send(buffer);
        }

        // --- 2. HTMLのみ広告削除と置換を行う ---
        let text = await response.text();

        // 広告削除
        text = text.replace(/<script[^>]*universityshocksooner\.com[^>]*><\/script>/gi, "");
        text = text.replace(/<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, "");
        text = text.split("universityshocksooner.com").join("localhost");

        // ドメイン同期
        const domains = ["mangarw.com", "myproxy0108.workers.dev", "72016.workers.dev"];
        domains.forEach(d => { text = text.split(d).join(currentHost); });

        // コード注入
        text = text.replace('<head>', '<head>' + INJECT_CODE);

        res.set("Content-Type", "text/html; charset=utf-8");
        return res.status(response.status).send(text);

    } catch (error) {
        console.error('Vercel Error:', error.message);
        if (!res.headersSent) res.status(200).send(`
            <body style="background:#000;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
                <div style="text-align:center;">
                    <p>接続がタイムアウトしました。リロードしてください。</p>
                    <button onclick="location.reload()" style="padding:10px 20px;border-radius:20px;border:none;background:#3b82f6;color:#fff;cursor:pointer;">再読み込み</button>
                </div>
            </body>
        `);
    }
});

module.exports = app;
