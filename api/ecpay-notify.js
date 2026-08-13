// Vercel Serverless Function: POST /api/ecpay-logistics-notify
// 這支是 api/ecpay-logistics-create.js 建立託運單時，設定給綠界的 ServerReplyURL。
//
// ⚠️ 綠界物流的 /Express/Create 常常不是「打了就馬上回你最終結果」，
// 有時候第一時間回的是「訂單處理中(綠界已收到訂單資料)」這種還沒確定的訊息，
// 真正確認好的託運單號（CVSPaymentNo / CVSValidationNo）跟最終狀態，
// 綠界會用伺服器對伺服器的方式另外呼叫這支 API 通知我們，不是客人或賣家的瀏覽器在等。
// 這支之前一直沒有做，所以就算託運單其實有建立成功，我們這邊也永遠收不到最終確認。
//
// 綠界規定這支要回傳純文字 '1|OK'（收到了），不能回 JSON，
// 不然綠界會判定失敗、每隔一段時間重打一次。
//
// 需要的環境變數（跟 api/ecpay-logistics-create.js 共用同一組）：
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

const APP_ID = 'fann-beauty-production-v1';

const TEST_CREDENTIALS = { hashKey: '5294y06JbISpM5x9', hashIv: 'v77hoKGq4kWxNNIS' };
const HASH_KEY = process.env.ECPAY_HASH_KEY || TEST_CREDENTIALS.hashKey;
const HASH_IV = process.env.ECPAY_HASH_IV || TEST_CREDENTIALS.hashIv;

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
    try {
        const body = req.body || {};
        console.log('ecpay-logistics-notify received:', body);

        const receivedMac = body.CheckMacValue;
        if (receivedMac && genCheckMacValue(body) !== receivedMac) {
            console.error('ecpay-logistics-notify: CheckMacValue 驗證失敗', body);
            res.status(200).send('0|CheckMacValue Error');
            return;
        }

        const tradeNo = body.MerchantTradeNo;
        if (!tradeNo) {
            res.status(200).send('1|OK');
            return;
        }

        const db = admin.firestore();
        const snap = await db.collection(`artifacts/${APP_ID}/public/data/orders`)
            .where('cvsLogistics.tradeNo', '==', tradeNo).get();

        if (!snap.empty) {
            const rtnCode = String(body.RtnCode || '');
            const logisticsInfo = {
                tradeNo,
                allPayLogisticsID: body.AllPayLogisticsID || '',
                cvsPaymentNo: body.CVSPaymentNo || '',
                cvsValidationNo: body.CVSValidationNo || '',
                logisticsStatus: body.LogisticsStatus || '',
                rtnMsg: body.RtnMsg || '',
                status: rtnCode === '1' || body.AllPayLogisticsID ? 'created' : 'failed',
                updatedAt: new Date().toISOString()
            };
            const batch = db.batch();
            snap.forEach(doc => {
                batch.set(doc.ref, { cvsLogistics: logisticsInfo }, { merge: true });
            });
            await batch.commit();
        } else {
            console.error('ecpay-logistics-notify: 找不到對應訂單', tradeNo);
        }

        res.status(200).send('1|OK');
    } catch (err) {
        console.error('ecpay-logistics-notify error:', err);
        res.status(200).send('0|Server Error');
    }
};
