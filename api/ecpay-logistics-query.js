// Vercel Serverless Function: POST /api/ecpay-logistics-query
// 賣家在後台點「🔄 查詢最新狀態」時呼叫這支，主動去問綠界「這筆託運單到底建好了沒」，
// 不用再乾等綠界的 ServerReplyURL 通知、也不用手動去綠界後台複製單號貼過來。
//
// 綠界物流有一支專門查詢的 API：Helper/QueryLogisticsTradeInfo/V5，
// 用當初建立時記錄下來的 MerchantTradeNo 就能查到最新狀態跟正式的 AllPayLogisticsID。
//
// 需要的環境變數（跟其他物流 API 共用同一組）：
//   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
//   ECPAY_MERCHANT_ID / ECPAY_HASH_KEY / ECPAY_HASH_IV / ECPAY_STAGE
//   ADMIN_NOTIFY_KEY

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
    // ✅ 物流 API 的檢查碼規定用 MD5，跟金流付款不一樣
    return crypto.createHash('md5').update(encoded).digest('hex').toUpperCase();
};

module.exports = async function handler(req, res) {
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

    const { orderIds, tradeNo } = req.body || {};
    if (!tradeNo) { res.status(400).json({ error: '缺少託運單交易編號' }); return; }
    if (!Array.isArray(orderIds) || orderIds.length === 0) { res.status(400).json({ error: '缺少訂單 ID' }); return; }

    try {
        const params = {
            MerchantID: MERCHANT_ID,
            MerchantTradeNo: tradeNo,
            TimeStamp: String(Math.floor(Date.now() / 1000))
        };
        params.CheckMacValue = genCheckMacValue(params);

        const body = new URLSearchParams(params).toString();
        const ecpayRes = await fetch(`${LOGISTICS_HOST}/Helper/QueryLogisticsTradeInfo/V5`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });
        const rawText = await ecpayRes.text();
        console.log('ecpay-logistics-query raw response:', rawText);

        const resultParams = new URLSearchParams(rawText);
        const allPayLogisticsID = resultParams.get('AllPayLogisticsID') || '';
        const rtnMsg = resultParams.get('RtnMsg') || resultParams.get('LogisticsStatus') || '';

        if (!allPayLogisticsID) {
            res.status(200).json({ ok: false, stillProcessing: true, message: rtnMsg || '綠界那邊還沒有最終結果，晚點再查一次' });
            return;
        }

        const logisticsInfo = {
            tradeNo,
            allPayLogisticsID,
            cvsPaymentNo: resultParams.get('CVSPaymentNo') || '',
            cvsValidationNo: resultParams.get('CVSValidationNo') || '',
            rtnMsg,
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
        console.error('ecpay-logistics-query error:', err);
        res.status(500).json({ error: '查詢失敗：' + String(err.message || err) });
    }
};
