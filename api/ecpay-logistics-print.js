// Vercel Serverless Function: GET /api/ecpay-logistics-print?logisticsId=<AllPayLogisticsID>
// 賣家在後台點「列印託運單」時開這支，組好簽章後自動送到綠界，
// 綠界會回傳可以直接列印的 7-11 交貨便託運單條碼頁面（PDF/圖片，由綠界那邊產生）。
//
// 需要的環境變數（跟 api/ecpay-checkout.js 共用同一組）：
//   ECPAY_MERCHANT_ID / ECPAY_HASH_KEY / ECPAY_HASH_IV / ECPAY_STAGE

const crypto = require('crypto');

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

const escapeHtml = (str) => String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

module.exports = async function handler(req, res) {
    const logisticsId = typeof req.query.logisticsId === 'string' ? req.query.logisticsId : '';
    // ⚠️ 批次列印：綠界的 7-11 C2C 列印頁面文件記載可以把多筆
    // AllPayLogisticsID / CVSPaymentNo / CVSValidationNo 用逗號串在一起，一次送出，
    // 綠界會回傳一張包含好幾筆託運單的合併頁面，一次列印完，不用一張一張分開開視窗。
    // ⚠️ 這段批次格式沒有拿真實多筆訂單測試過，第一次用麻煩幫我確認：
    // 選多筆一起送出後，跳出來的頁面是不是真的把每一筆託運單都印出來了（不是只有第一筆）。
    if (!logisticsId || !/^[A-Za-z0-9]{1,20}(,[A-Za-z0-9]{1,20})*$/.test(logisticsId)) {
        res.status(400).send('缺少或格式錯誤的託運單編號');
        return;
    }
    // ⚠️ 光帶 AllPayLogisticsID 綠界會查不到寄貨編號（跳出 CVSPaymentNo is null），
    // 一定要把查詢訂單時拿到的 CVSPaymentNo/CVSValidationNo 也一起帶過去才能正確列印
    const cvsPaymentNo = typeof req.query.cvsPaymentNo === 'string' ? req.query.cvsPaymentNo : '';
    const cvsValidationNo = typeof req.query.cvsValidationNo === 'string' ? req.query.cvsValidationNo : '';
    if (!cvsPaymentNo || !cvsValidationNo) {
        res.status(400).send('缺少寄貨編號，請先在後台重新查詢最新狀態');
        return;
    }
    const idCount = logisticsId.split(',').length;
    if (cvsPaymentNo.split(',').length !== idCount || cvsValidationNo.split(',').length !== idCount) {
        res.status(400).send('批次列印的筆數對不起來，請重新操作');
        return;
    }

    const params = {
        MerchantID: MERCHANT_ID,
        AllPayLogisticsID: logisticsId,
        CVSPaymentNo: cvsPaymentNo,
        CVSValidationNo: cvsValidationNo
    };
    params.CheckMacValue = genCheckMacValue(params);

    const inputs = Object.entries(params)
        .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
        .join('\n');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`<!DOCTYPE html>
<html lang="zh-TW">
<head><meta charset="UTF-8"><title>正在開啟託運單...</title></head>
<body>
<p style="font-family:sans-serif;text-align:center;margin-top:3em;">正在開啟託運單，請稍候...</p>
<form id="printForm" method="post" action="${LOGISTICS_HOST}/Express/PrintUnimartC2COrderInfo">
${inputs}
</form>
<script>document.getElementById('printForm').submit();</script>
</body>
</html>`);
};
