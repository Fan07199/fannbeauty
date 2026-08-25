// Vercel Serverless Function: GET /api/ecpay-checkout?tradeNo=<MerchantTradeNo>
// 客人結帳選「信用卡付款」時，網站會把瀏覽器導到這支 API；這支 API 從 Firestore
// 撈出這筆訂單真正的金額（絕對不能相信前端傳來的金額，一定要後端自己算），
// 組好綠界要求的欄位跟簽章（CheckMacValue），回傳一個會自動送出的表單頁面，
// 瀏覽器收到後會自動 POST 到綠界，跳轉到刷卡頁。
//
// 需要的環境變數（在 Vercel 專案設定 → Environment Variables 加）：
//   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY  — 跟 api/og.js 共用同一組
//   ECPAY_MERCHANT_ID   — 綠界特店編號（測試環境固定用 2000132，正式環境用審核通過後的商店代號）
//   ECPAY_HASH_KEY      — 綠界介接 HashKey
//   ECPAY_HASH_IV       — 綠界介接 HashIV
//   ECPAY_STAGE         — 'test' 用測試環境（預設），'prod' 才會打正式環境
//   SITE_URL            — 網站網址，預設 https://www.fann-beauty.com

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
const SITE_URL = process.env.SITE_URL || 'https://www.fann-beauty.com';

// ✅ 測試環境用綠界官方公開的測試特店資訊（所有開發者共用，不是機密），
// 這樣還沒設定正式金鑰之前也能先跑通整個流程；正式上線前要把 ECPAY_STAGE 設成 'prod'
// 並且把下面三個環境變數換成真正審核過的那組
const TEST_CREDENTIALS = {
    merchantId: '2000132',
    hashKey: '5294y06JbISpM5x9',
    hashIv: 'v77hoKGq4kWxNNIS'
};

const isProd = (process.env.ECPAY_STAGE || '').trim().toLowerCase() === 'prod';
const ECPAY_HOST = isProd ? 'https://payment.ecpay.com.tw' : 'https://payment-stage.ecpay.com.tw';
// ✅ 測試站一律用公開測試金鑰，不管環境變數裡的正式金鑰有沒有設定，避免「測試站+正式金鑰」這種
// 兩邊對不起來的組合（正式金鑰在測試站上一定會被拒絕，跟金鑰打錯字的錯誤訊息一模一樣，很容易誤判）
const MERCHANT_ID = isProd ? (process.env.ECPAY_MERCHANT_ID || TEST_CREDENTIALS.merchantId) : TEST_CREDENTIALS.merchantId;
const HASH_KEY = isProd ? (process.env.ECPAY_HASH_KEY || TEST_CREDENTIALS.hashKey) : TEST_CREDENTIALS.hashKey;
const HASH_IV = isProd ? (process.env.ECPAY_HASH_IV || TEST_CREDENTIALS.hashIv) : TEST_CREDENTIALS.hashIv;

// ✅ 綠界要求的網址編碼規則（.NET 的 UrlEncode 風格），跟 JS 內建的 encodeURIComponent 不完全一樣，
// 這段字元對照是官方文件規定的，算錯簽章就完全對不上、付款頁會直接打不開
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

const escapeHtml = (str) => String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ─── 促銷折扣計算（跟 index.html / admin.html 的邏輯保持一致，見那邊的註解說明）───
// ✅ 這裡只用「這次結帳的商品」自己算，不去合併客人當天其他筆訂單——
// 因為信用卡是當下就要收一個確定的金額，沒辦法像匯款那樣事後彈性合併計算，
// 剛好也是客人在確認訂單畫面看到「預估折扣」時所用的同一套算法，金額對得起來
const isPromoActive = (promo) => {
    if (!promo || !promo.enabled) return false;
    const now = new Date();
    if (promo.startAt && new Date(promo.startAt) > now) return false;
    if (promo.endAt && new Date(promo.endAt) < now) return false;
    return true;
};
const getEligible = (promo, codeGroups) => {
    let subtotal = 0, qty = 0;
    const useWL = promo.itemFilter === 'whitelist' && Array.isArray(promo.whitelist) && promo.whitelist.length > 0;
    Object.entries(codeGroups).forEach(([code, cg]) => {
        if (useWL && !promo.whitelist.includes(code)) return;
        subtotal += cg.subtotal || 0;
        qty += cg.totalQty || 0;
    });
    return { subtotal, qty };
};
// ✅ locked=true 代表這個促銷是從訂單自己存的 promoSnapshot 來的（下單當下鎖住的那份），
// 這種情況不用再檢查 enabled/時間區間——鎖住的快照本來就代表「下單當下這個活動確實在跑」，
// 不然遇到活動剛好在客人下單後、按去刷卡前結束/被關掉，這裡會誤判成沒有優惠，多收客人錢
const calcDiscount = (promo, locked, codeGroups, eligibleTotalOverride = null) => {
    if (!locked && !isPromoActive(promo)) return 0;
    const { subtotal: rawTotal, qty: eQty } = getEligible(promo, codeGroups);
    const eTotal = eligibleTotalOverride != null ? eligibleTotalOverride : rawTotal;
    if (eTotal === 0) return 0;
    switch (promo.type) {
        case 'fixed':
            return Math.min((Number(promo.value) || 0) * eQty, eTotal);
        case 'percent': {
            const pct = Number(promo.percent) || 100;
            return Math.round(eTotal * (100 - pct) / 100);
        }
        case 'threshold': {
            const tiers = Array.isArray(promo.tiers) && promo.tiers.length > 0
                ? promo.tiers
                : (promo.threshold ? [{ threshold: promo.threshold, discount: promo.thresholdDiscount }] : []);
            const basisValue = promo.tierBasis === 'qty' ? eQty : eTotal;
            const applicable = tiers
                .filter(t => basisValue >= (Number(t.threshold) || 0))
                .sort((a, b) => (Number(b.threshold) || 0) - (Number(a.threshold) || 0))[0];
            return applicable ? (Number(applicable.discount) || 0) : 0;
        }
        default: return 0;
    }
};
const promoEligibleCodes = (promo, codeGroups) => {
    const useWL = promo.itemFilter === 'whitelist' && Array.isArray(promo.whitelist) && promo.whitelist.length > 0;
    return Object.keys(codeGroups).filter(code => !useWL || promo.whitelist.includes(code));
};
// ✅ p1/p2 是 {promo, locked} 這種形狀（來自 resolvePromo），不是原始的促銷設定物件
const calcTotalDiscount = (codeGroups, p1, p2) => {
    const d1 = p1.promo ? calcDiscount(p1.promo, p1.locked, codeGroups) : 0;
    if (!p2.promo) return d1;
    const { subtotal: elig2 } = getEligible(p2.promo, codeGroups);
    if (elig2 === 0) return d1;
    const codes1 = p1.promo ? new Set(promoEligibleCodes(p1.promo, codeGroups)) : new Set();
    const hasOverlap = promoEligibleCodes(p2.promo, codeGroups).some(c => codes1.has(c));
    const remaining2 = hasOverlap ? Math.max(0, elig2 - d1) : elig2;
    const d2 = calcDiscount(p2.promo, p2.locked, codeGroups, remaining2);
    return d1 + d2;
};
const calcGrandDiscount = (codeGroups, itemTotal, p1, p2, eb) => {
    const promoDiscount = calcTotalDiscount(codeGroups, p1, p2);
    if (!eb.promo || (!eb.locked && !isPromoActive(eb.promo))) return promoDiscount;
    const remaining = Math.max(0, itemTotal - promoDiscount);
    const ebDiscount = Math.round(remaining * (100 - (Number(eb.promo.percent) || 100)) / 100);
    return promoDiscount + ebDiscount;
};
// ✅ 促銷解析規則跟 admin.html / index.html 完全對齊：訂單自己的 promoSnapshot 存在就優先用、
// 而且視為鎖定（不再檢查 enabled/時間區間）；沒有快照的舊訂單才 fallback 檢查目前的即時活動設定，
// 並且是拿「下單當下的時間」去比對活動區間，不是拿「現在刷卡的時間」比對
const resolvePromo = (snapshot, live, atDate) => {
    if (snapshot && snapshot.enabled) return { promo: snapshot, locked: true };
    if (live && live.enabled && (!live.startAt || new Date(live.startAt) <= atDate) && (!live.endAt || new Date(live.endAt) >= atDate)) return { promo: live, locked: false };
    return { promo: null, locked: false };
};

module.exports = async function handler(req, res) {
    const tradeNo = typeof req.query.tradeNo === 'string' ? req.query.tradeNo : '';
    if (!tradeNo || !/^[A-Za-z0-9]{1,20}$/.test(tradeNo)) {
        res.status(400).send('缺少或格式錯誤的訂單編號');
        return;
    }
    if (!process.env.FIREBASE_PROJECT_ID) {
        res.status(500).send('伺服器尚未設定 Firebase 金鑰');
        return;
    }

    try {
        const db = admin.firestore();
        const settingsCol = db.collection(`artifacts/${APP_ID}/public/data/settings`);
        const [snap, storeConfigSnap, promoSnap, promo2Snap, earlyBirdSnap] = await Promise.all([
            db.collection(`artifacts/${APP_ID}/public/data/orders`).where('ecpayTradeNo', '==', tradeNo).get(),
            settingsCol.doc('storeConfig').get(),
            settingsCol.doc('promotion').get(),
            settingsCol.doc('promotion2').get(),
            settingsCol.doc('earlyBird').get()
        ]);

        if (snap.empty) {
            res.status(404).send('找不到這筆訂單，請重新結帳');
            return;
        }

        // ✅ 金額一定要用 Firestore 裡實際存的商品單價 x 數量、加上目前正在跑的促銷活動重新算一次，
        // 絕對不能相信網址列或前端傳來的任何金額參數
        const codeGroups = {};
        const itemNames = [];
        let customerName = '';
        let creditApplied = 0;
        let promoSnapshot = null, promoSnapshot2 = null, earlyBirdSnapshot = null, orderCreatedAt = null;
        snap.forEach(doc => {
            const o = doc.data();
            const qty = Number(o.quantity) || 1;
            const price = Number(o.price) || 0;
            const code = o.itemCode || o.productName || doc.id;
            if (!codeGroups[code]) codeGroups[code] = { subtotal: 0, totalQty: 0 };
            codeGroups[code].subtotal += price * qty;
            codeGroups[code].totalQty += qty;
            itemNames.push(`${o.productName || o.itemCode}${o.spec ? `(${o.spec})` : ''}x${qty}`);
            customerName = o.customerName || customerName;
            creditApplied += Number(o.creditApplied) || 0;
            if (!promoSnapshot && o.promoSnapshot) promoSnapshot = o.promoSnapshot;
            if (!promoSnapshot2 && o.promoSnapshot2) promoSnapshot2 = o.promoSnapshot2;
            if (!earlyBirdSnapshot && o.earlyBirdSnapshot) earlyBirdSnapshot = o.earlyBirdSnapshot;
            if (!orderCreatedAt && o.createdAt) orderCreatedAt = o.createdAt;
        });
        const itemTotal = Object.values(codeGroups).reduce((s, cg) => s + cg.subtotal, 0);
        if (itemTotal <= 0) {
            res.status(400).send('訂單金額異常');
            return;
        }

        const storeConfig = storeConfigSnap.exists ? storeConfigSnap.data() : {};
        const promotion = promoSnap.exists ? promoSnap.data() : null;
        const promotion2 = promo2Snap.exists ? promo2Snap.data() : null;
        const earlyBird = earlyBirdSnap.exists ? earlyBirdSnap.data() : null;

        const orderDate = orderCreatedAt && typeof orderCreatedAt.toDate === 'function'
            ? orderCreatedAt.toDate()
            : (orderCreatedAt ? new Date(orderCreatedAt) : new Date());
        const p1 = resolvePromo(promoSnapshot, promotion, orderDate);
        const p2 = resolvePromo(promoSnapshot2, promotion2, orderDate);
        const eb = resolvePromo(earlyBirdSnapshot, earlyBird, orderDate);
        const promoDiscount = calcGrandDiscount(codeGroups, itemTotal, p1, p2, eb);
        const threshold = storeConfig.freeShippingThreshold || 1500;
        const shippingFeeAmt = storeConfig.shippingFee ?? 38;
        const payableForShipping = Math.max(0, itemTotal - promoDiscount - creditApplied);
        const hasShippingFee = payableForShipping < threshold && itemTotal > 0;
        const baseTotal = hasShippingFee ? itemTotal + shippingFeeAmt : itemTotal;
        const totalAmount = Math.max(0, baseTotal - promoDiscount - creditApplied);

        if (totalAmount <= 0) {
            res.status(400).send('訂單金額為 0，不需要刷卡');
            return;
        }

        // ✅ 除錯用：把折扣是怎麼算出來的印出來，之後如果客人刷卡金額跟後台顯示的金額對不起來，
        // 直接查這支的 log 就能看到當下用了哪個促銷（有沒有正確吃到訂單自己的 promoSnapshot）、
        // 折了多少錢，不用再用猜的
        console.log('ecpay-checkout 金額試算:', {
            tradeNo, itemTotal, promoDiscount, creditApplied, hasShippingFee, shippingFeeAmt, totalAmount,
            promo1: p1.promo ? { name: p1.promo.name, locked: p1.locked } : null,
            promo2: p2.promo ? { name: p2.promo.name, locked: p2.locked } : null,
            earlyBird: eb.promo ? { name: eb.promo.name, locked: eb.locked } : null
        });

        // ✅ 除錯用：不含任何密鑰，只印出「用了哪個商店代號、打去正式站還是測試站」，
        // 方便在 Vercel 的 Logs 分頁對照，確認環境變數有沒有生效
        console.log('ecpay-checkout debug:', { MERCHANT_ID, isProd, ECPAY_HOST, hasHashKey: !!process.env.ECPAY_HASH_KEY, hasHashIv: !!process.env.ECPAY_HASH_IV, rawStage: process.env.ECPAY_STAGE });

        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const tradeDate = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

        const params = {
            MerchantID: MERCHANT_ID,
            MerchantTradeNo: tradeNo,
            MerchantTradeDate: tradeDate,
            PaymentType: 'aio',
            TotalAmount: String(Math.round(totalAmount)),
            TradeDesc: 'Fann.Beauty 選購訂單',
            ItemName: itemNames.join('#').slice(0, 400),
            ReturnURL: `${SITE_URL}/api/ecpay-notify`,
            ChoosePayment: 'Credit',
            ClientBackURL: `${SITE_URL}/?paidTrade=${encodeURIComponent(tradeNo)}`,
            EncryptType: '1'
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
<title>正在前往付款頁面...</title>
</head>
<body>
<p style="font-family:sans-serif;text-align:center;margin-top:3em;">正在前往付款頁面，請稍候 ${escapeHtml(customerName)}...</p>
<form id="ecpayForm" method="post" action="${ECPAY_HOST}/Cashier/AioCheckOut/V5">
${inputs}
</form>
<script>document.getElementById('ecpayForm').submit();</script>
</body>
</html>`);
    } catch (err) {
        console.error('ecpay-checkout error:', err);
        res.status(500).send('建立付款失敗，請稍後再試');
    }
};
