// Vercel Serverless Function: GET /api/og?id=<shopProducts 文件 id>
// 讓分享單一商品連結時，LINE/FB 等 App 抓到的縮圖是「那件商品自己的照片」，
// 而不是整個網站共用的 logo。
//
// 原理：LINE/FB 讀連結預覽時不會執行網站的 JavaScript，只會讀最原始的 HTML，
// 所以沒辦法讓 SPA 自己根據網址參數換縮圖。這支函式在伺服器端先查出商品資料，
// 組一份帶正確 og:image 的 HTML 回傳給預覽機器人；真人點進來則會被立刻轉址到
// 真正的選購頁（<meta http-equiv="refresh"> + JS 兩道保險，幾乎感覺不到延遲）。
//
// 需要的環境變數（在 Vercel 專案設定 → Environment Variables 加，來自 Firebase
// 主控台「專案設定 → 服務帳戶 → 產生新的私密金鑰」下載的 JSON 檔）：
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY   （貼上完整內容即可，程式碼會自動處理換行符號）

const admin = require('firebase-admin');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
        })
    });
}

const SITE_URL = 'https://fannbeauty.vercel.app';
const APP_ID = 'fann-beauty-production-v1'; // ✅ 要跟 index.html / admin.html 裡的 appId 常數一致
const DEFAULT_IMAGE = `${SITE_URL}/logo.png`;

const escapeHtml = (str) => String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

module.exports = async function handler(req, res) {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    const productUrl = id ? `${SITE_URL}/?product=${encodeURIComponent(id)}` : SITE_URL;

    let title = 'Fann.Beauty｜選購';
    let description = '精選女裝選購頁';
    let image = DEFAULT_IMAGE;

    if (id && process.env.FIREBASE_PROJECT_ID) {
        try {
            const db = admin.firestore();
            const snap = await db.doc(`artifacts/${APP_ID}/public/data/shopProducts/${id}`).get();
            if (snap.exists) {
                const p = snap.data();
                if (p.name) title = `${p.name}｜Fann.Beauty`;
                if (p.image) image = p.image;
                const priceLine = p.price ? `NT$ ${p.price}` : '';
                description = [priceLine, p.desc].filter(Boolean).join(' · ') || description;
            }
        } catch (err) {
            console.error('OG 商品查詢失敗:', err);
        }
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300'); // 快取 5 分鐘，減少重複查 Firestore 的次數
    res.status(200).send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="0; url=${escapeHtml(productUrl)}">
<title>${escapeHtml(title)}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:url" content="${escapeHtml(productUrl)}">
<meta name="twitter:card" content="summary_large_image">
<script>location.replace(${JSON.stringify(productUrl)});</script>
</head>
<body>
<p>正在前往商品頁面...</p>
</body>
</html>`);
};
