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
//   ECPAY_MERCHANT_ID / ECPAY_STAGE / SITE_URL

const isProd = process.env.ECPAY_STAGE === 'prod';
const ECPAY_LOGISTICS_HOST = isProd ? 'https://logistics.ecpay.com.tw' : 'https://logistics-stage.ecpay.com.tw';
const MERCHANT_ID = process.env.ECPAY_MERCHANT_ID || '2000132'; // 測試環境公開特店編號
const FALLBACK_SITE_URL = 'https://www.fann-beauty.com';

const escapeHtml = (str) => String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

module.exports = async function handler(req, res) {
    const SITE_URL = process.env.SITE_URL || (req.headers.host ? `https://${req.headers.host}` : FALLBACK_SITE_URL);

    // ✅ 這裡只是選門市，還沒有真正的訂單編號，用時間戳記湊一組符合格式（英數字、≤20碼）的暫用編號就好，
    // 選店結果本身不會拿這組編號去查訂單，客人選完店之後是直接把門市資訊帶回官網、下單當下才會真正寫進訂單
    const tempTradeNo = `MAP${Date.now().toString(36).toUpperCase()}`;

    const params = {
        MerchantID: MERCHANT_ID,
        MerchantTradeNo: tempTradeNo,
        LogisticsType: 'CVS',
        LogisticsSubType: 'UNIMARTC2C',
        IsCollection: 'Y', // ✅ 取貨付款（貨到付款），不是取貨不付款
        ServerReplyURL: `${SITE_URL}/api/ecpay-logistics-callback`
    };

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
