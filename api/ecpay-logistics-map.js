// Vercel Serverless Function: GET /api/ecpay-logistics-map
// 客人結帳選「超商取貨付款(7-11)」時，點「選擇門市」會整頁導到這支 API，
// 這支 API 回一個會自動送出的表單，直接 POST 到綠界的電子地圖選店頁面。
// 客人在綠界頁面選好 7-11 門市後，綠界會把瀏覽器導到 ServerReplyURL
// （也就是 api/ecpay-logistics-callback.js），那支再把客人導回官網、帶著選好的門市資訊。
//
// 用「整頁導頁」而不是彈出視窗，是因為很多客人是用 LINE 內建瀏覽器開官網，
// 彈出視窗常常會被擋掉或行為不穩定，整頁導頁相容性比較好、比較不會選了門市卻回不去。
//
// 需要的環境變數（跟 api/ecpay-checkout.js 共用同一組）：
//   ECPAY_MERCHANT_ID / ECPAY_HASH_KEY / ECPAY_HASH_IV / ECPAY_STAGE / SITE_URL

const crypto = require('crypto');

const TEST_CREDENTIALS = { merchantId: '2000132', hashKey: '5294y06JbISpM5x9', hashIv: 'v77hoKGq4kWxNNIS' };
const isProd = (process.env.ECPAY_STAGE || '').trim().toLowerCase() === 'prod';
const ECPAY_LOGISTICS_HOST = isProd ? 'https://logistics.ecpay.com.tw' : 'https://logistics-stage.ecpay.com.tw';
const MERCHANT_ID = isProd ? (process.env.ECPAY_MERCHANT_ID || TEST_CREDENTIALS.merchantId) : TEST_CREDENTIALS.merchantId;
const HASH_KEY = isProd ? (process.env.ECPAY_HASH_KEY || TEST_CREDENTIALS.hashKey) : TEST_CREDENTIALS.hashKey;
const HASH_IV = isProd ? (process.env.ECPAY_HASH_IV || TEST_CREDENTIALS.hashIv) : TEST_CREDENTIALS.hashIv;
const FALLBACK_SITE_URL = 'https://www.fann-beauty.com';

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
    const SITE_URL = process.env.SITE_URL || (req.headers.host ? `https://${req.headers.host}` : FALLBACK_SITE_URL);

    // ✅ 這裡只是選門市，還沒有真正的訂單編號，用時間戳記湊一組符合格式（英數字、≤20碼）的暫用編號就好，
    // 選店結果本身不會拿這組編號去查訂單，客人選完店之後是直接把門市資訊帶回官網、下單當下才會真正寫進訂單
    const tempTradeNo = `MAP${Date.now().toString(36).toUpperCase()}`;

    // ✅ 客人選的付款方式、填的手機/收件人姓名，原本只存在瀏覽器的 localStorage，指望繞去綠界選店
    // 再繞回來之後還在——但 Safari 私密瀏覽等情況下，跨網域繞一圈回來 localStorage 可能會被清掉，
    // 客人選完門市回來就變成要重填一次、付款方式也被打回「匯款」。這裡把這三樣東西一起帶在
    // ServerReplyURL 上（綠界選店完成後會原樣把這個網址導回來，query string 不會被綠界動到），
    // 讓門市資訊跟這三樣東西用同一條路徑回到官網，不再只靠 localStorage 能不能撐過這趟。
    const replyExtra = new URLSearchParams({
        pm: typeof req.query.pm === 'string' ? req.query.pm.slice(0, 50) : '',
        custPhone: typeof req.query.custPhone === 'string' ? req.query.custPhone.slice(0, 50) : '',
        custReceiver: typeof req.query.custReceiver === 'string' ? req.query.custReceiver.slice(0, 100) : ''
    });

    const params = {
        MerchantID: MERCHANT_ID,
        MerchantTradeNo: tempTradeNo,
        LogisticsType: 'CVS',
        LogisticsSubType: 'UNIMARTC2C',
        IsCollection: 'Y', // ✅ 取貨付款（貨到付款），不是取貨不付款
        ServerReplyURL: `${SITE_URL}/api/ecpay-logistics-callback?${replyExtra.toString()}`
    };
    params.CheckMacValue = genCheckMacValue(params);

    const inputs = Object.entries(params)
        .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
        .join('\n');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>正在開啟門市選擇...</title>
</head>
<body>
<p style="font-family:sans-serif;text-align:center;margin-top:3em;">正在為您開啟 7-11 門市選擇，請稍候...</p>
<form id="mapForm" method="post" action="${ECPAY_LOGISTICS_HOST}/Express/map">
${inputs}
</form>
<script>document.getElementById('mapForm').submit();</script>
</body>
</html>`);
};
