// Vercel Serverless Function: POST /api/ecpay-logistics-create
// 賣家在後台按「建立超商託運單」時呼叫這支，跟綠界的物流 API 要一組正式的
// 託運單號（AllPayLogisticsID / 7-11 交寄用的 CVSPaymentNo + CVSValidationNo），
// 之後才能列印真正貼在包裹上的託運單條碼。
//
// ⚠️ 這支打的是綠界「正式」物流環境（跟 ECPAY_STAGE 設定一致），一旦呼叫成功，
// 綠界那邊就會真的產生一筆物流託運單記錄，不是測試模擬，請小心不要重複亂按。
//
// 需要的環境變數（跟 api/ecpay-checkout.js 共用同一組，另外要在 Vercel 加 ADMIN_NOTIFY_KEY 驗證身份）：
//   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
//   ECPAY_MERCHANT_ID / ECPAY_HASH_KEY / ECPAY_HASH_IV / ECPAY_STAGE
//   ADMIN_NOTIFY_KEY   — 跟 admin.html 呼叫時帶的 x-admin-key 要一致，避免外人亂打這支建立一堆託運單
//   SITE_URL

const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
        })
    });
}

const APP_ID = 'fann-beauty-production-v1';
const FALLBACK_SITE_URL = 'https://www.fann-beauty.com';

const TEST_CREDENTIALS = { merchantId: '2000132', hashKey: '5294y06JbISpM5x9', hashIv: 'v77hoKGq4kWxNNIS' };
const isProd = (process.env.ECPAY_STAGE || '').trim().toLowerCase() === 'prod';
const LOGISTICS_HOST = isProd ? 'https://logistics.ecpay.com.tw' : 'https://logistics-stage.ecpay.com.tw';
const MERCHANT_ID = isProd ? (process.env.ECPAY_MERCHANT_ID || TEST_CREDENTIALS.merchantId) : TEST_CREDENTIALS.merchantId;
const HASH_KEY = isProd ? (process.env.ECPAY_HASH_KEY || TEST_CREDENTIALS.hashKey) : TEST_CREDENTIALS.hashKey;
const HASH_IV = isProd ? (process.env.ECPAY_HASH_IV || TEST_CREDENTIALS.hashIv) : TEST_CREDENTIALS.hashIv;

const ecpayUrlEncode = (str) => encodeURIComponent(str)
    .replace(/%20/g, '+').replace(/%2d/gi, '-').replace(/%5f/gi, '_')
    .replace(/%2e/gi, '.').replace(/%21/gi, '!').replace(/%2a/gi, '*')
    .replace(/%28/gi, '(').replace(/%29/gi, ')');

const genCheckMacValue = (params) => {
    const keys = Object.keys(params).filter(k => k !== 'CheckMacValue').sort((a, b) => a.localeCompare(b));
    let raw = `HashKey=${HASH_KEY}`;
    keys.forEach(k => { raw += `&${k}=${params[k]}`; });
    raw += `&HashIV=${HASH_IV}`;
    const encoded = ecpayUrlEncode(raw).toLowerCase();
    // ✅ 注意：物流 API 的檢查碼規定用 MD5，跟金流付款（ecpay-checkout.js 用 SHA256）不一樣，
    // 這是兩支之前一直對不起來簽章的真正原因
    return crypto.createHash('md5').update(encoded).digest('hex').toUpperCase();
};

module.exports = async function handler(req, res) {
    // ✅ 賣家後台 admin.html 是放在另一個網域（fann-seller 專案），跟這支 API 所在的
    // fannbeauty 網域不同，瀏覽器會把這種呼叫當成跨網域請求（CORS），沒有這幾行標頭
    // 瀏覽器會直接擋掉，連錯誤訊息都看不到。因為這支本來就有 x-admin-key 驗證身份，
    // 開放跨網域呼叫不會降低安全性。
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    const adminKey = req.headers['x-admin-key'];
    if (!process.env.ADMIN_NOTIFY_KEY || adminKey !== process.env.ADMIN_NOTIFY_KEY) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }

    const { orderIds, goodsName, amount, receiverName, receiverPhone, cvsStoreId, senderName, senderPhone } = req.body || {};
    if (!Array.isArray(orderIds) || orderIds.length === 0) { res.status(400).json({ error: '缺少訂單 ID' }); return; }
    if (!cvsStoreId || !receiverName || !receiverPhone) { res.status(400).json({ error: '缺少門市代號或收件人資訊' }); return; }
    const totalAmount = Math.round(Number(amount) || 0);
    if (totalAmount <= 0 || totalAmount > 20000) { res.status(400).json({ error: '金額異常（7-11 取貨付款單筆上限為 $20,000）' }); return; }

    const SITE_URL = process.env.SITE_URL || FALLBACK_SITE_URL;

    try {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const tradeDate = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        const tradeNo = `FBL${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 4).toUpperCase()}`.slice(0, 20);

        const params = {
            MerchantID: MERCHANT_ID,
            MerchantTradeNo: tradeNo,
            MerchantTradeDate: tradeDate,
            LogisticsType: 'CVS',
            LogisticsSubType: 'UNIMARTC2C',
            GoodsAmount: String(totalAmount),
            CollectionAmount: String(totalAmount), // ✅ IsCollection=Y 時必填，且金額要跟 GoodsAmount 一樣
            IsCollection: 'Y',
            GoodsName: String(goodsName || 'Fann選購商品').slice(0, 50),
            SenderName: String(senderName || 'FannBeauty').slice(0, 10),
            SenderCellPhone: String(senderPhone || '').replace(/\D/g, '').slice(0, 20),
            ReceiverName: String(receiverName).slice(0, 10),
            ReceiverCellPhone: String(receiverPhone).replace(/\D/g, '').slice(0, 20),
            ReceiverStoreID: cvsStoreId,
            ServerReplyURL: `${SITE_URL}/api/ecpay-logistics-notify`
        };
        params.CheckMacValue = genCheckMacValue(params);

        const body = new URLSearchParams(params).toString();
        const ecpayRes = await fetch(`${LOGISTICS_HOST}/Express/Create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });
        const rawText = await ecpayRes.text();

        // ✅ 綠界這支 API 回傳的是網址參數格式的純文字（不是 JSON），例如
        // RtnCode=1&RtnMsg=...&AllPayLogisticsID=...&CVSPaymentNo=...&CVSValidationNo=...
        const resultParams = new URLSearchParams(rawText);
        const rtnCode = resultParams.get('RtnCode');
        const rtnMsg = resultParams.get('RtnMsg') || '';

        if (rtnCode !== '1') {
            console.error('ecpay-logistics-create 失敗:', rawText);
            res.status(400).json({ error: `綠界回覆失敗：${rtnMsg || rawText}` });
            return;
        }

        const logisticsInfo = {
            tradeNo,
            allPayLogisticsID: resultParams.get('AllPayLogisticsID') || '',
            cvsPaymentNo: resultParams.get('CVSPaymentNo') || '',
            cvsValidationNo: resultParams.get('CVSValidationNo') || '',
            createdAt: new Date().toISOString(),
            status: 'created'
        };

        const db = admin.firestore();
        const batch = db.batch();
        orderIds.forEach(id => {
            const ref = db.doc(`artifacts/${APP_ID}/public/data/orders/${id}`);
            batch.set(ref, { cvsLogistics: logisticsInfo }, { merge: true });
        });
        await batch.commit();

        res.status(200).json({ ok: true, logistics: logisticsInfo });
    } catch (err) {
        console.error('ecpay-logistics-create error:', err);
        res.status(500).json({ error: '建立託運單失敗：' + String(err.message || err) });
    }
};
