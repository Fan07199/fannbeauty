// Vercel Serverless Function: POST /api/ecpay-notify
// 綠界收到信用卡付款結果後，會用伺服器對伺服器的方式呼叫這支 API（不是客人的瀏覽器），
// 用來告訴我們「這筆訂單到底有沒有付款成功」，成功的話把訂單狀態改成已結單。
//
// 綠界規定這支一定要回傳純文字 '1|OK'（收到了、處理成功）或 '0|原因'（處理失敗），
// 不能回 JSON，不然綠界會判定失敗、每隔一段時間重打一次（最多重打好幾次）。
// 因為綠界可能重複呼叫，這裡的更新要做成「重複執行也不會出錯」（用 merge:true 覆蓋同樣的值就好）。
//
// 需要的環境變數（跟 api/ecpay-checkout.js 共用同一組）：
//   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
//   ECPAY_HASH_KEY / ECPAY_HASH_IV

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

const APP_ID = 'fann-beauty-production-v1'; // ✅ 要跟 index.html / admin.html 裡的 appId 常數一致

const TEST_CREDENTIALS = { hashKey: '5294y06JbISpM5x9', hashIv: 'v77hoKGq4kWxNNIS' };
const HASH_KEY = process.env.ECPAY_HASH_KEY || TEST_CREDENTIALS.hashKey;
const HASH_IV = process.env.ECPAY_HASH_IV || TEST_CREDENTIALS.hashIv;

// ✅ 跟 api/ecpay-checkout.js 完全一樣的簽章演算法，用來驗證這通真的是綠界打來的、內容沒被竄改
const ecpayUrlEncode = (str) => {
    return encodeURIComponent(str)
        .replace(/%20/g, '+')
        .replace(/%2d/gi, '-')
        .replace(/%5f/gi, '_')
        .replace(/%2e/gi, '.')
        .replace(/%21/gi, '!')
        .replace(/%2a/gi, '*')
        .replace(/%28/gi, '(')
        .replace(/%29/gi, ')');
};
const genCheckMacValue = (params) => {
    const keys = Object.keys(params).filter(k => k !== 'CheckMacValue').sort((a, b) => a.localeCompare(b));
    let raw = `HashKey=${HASH_KEY}`;
    keys.forEach(k => { raw += `&${k}=${params[k]}`; });
    raw += `&HashIV=${HASH_IV}`;
    const encoded = ecpayUrlEncode(raw).toLowerCase();
    return crypto.createHash('sha256').update(encoded).digest('hex').toUpperCase();
};

module.exports = async function handler(req, res) {
    try {
        const body = req.body || {};
        const receivedMac = body.CheckMacValue;
        if (!receivedMac || genCheckMacValue(body) !== receivedMac) {
            console.error('ecpay-notify: CheckMacValue 驗證失敗', body);
            res.status(200).send('0|CheckMacValue Error');
            return;
        }

        const tradeNo = body.MerchantTradeNo;
        const rtnCode = body.RtnCode;
        if (!tradeNo) {
            res.status(200).send('0|Missing MerchantTradeNo');
            return;
        }

        if (String(rtnCode) === '1') {
            const db = admin.firestore();
            const snap = await db.collection(`artifacts/${APP_ID}/public/data/orders`)
                .where('ecpayTradeNo', '==', tradeNo).get();

            if (!snap.empty) {
                const batch = db.batch();
                snap.forEach(doc => {
                    batch.set(doc.ref, {
                        status: 'completed',
                        paymentMethod: 'credit_card',
                        ecpayPaidAt: new Date().toISOString(),
                        ecpayTradeAmt: body.TradeAmt || null
                    }, { merge: true });
                });
                await batch.commit();
            } else {
                console.error('ecpay-notify: 找不到對應訂單', tradeNo);
            }
        } else {
            console.log('ecpay-notify: 付款未成功，RtnCode=', rtnCode, 'tradeNo=', tradeNo);
        }

        res.status(200).send('1|OK');
    } catch (err) {
        console.error('ecpay-notify error:', err);
        res.status(200).send('0|Server Error');
    }
};
