// Vercel Serverless Function: POST /api/ecpay-logistics-callback
// 綠界電子地圖選店完成後，會把客人的瀏覽器導到這裡（ServerReplyURL），
// 帶著客人選好的 7-11 門市資訊（POST 表單）。這支只是把資訊接住、
// 轉成網址參數，再把客人導回官網結帳頁，官網那邊會自動讀出來顯示。
//
// 不需要驗證 CheckMacValue，因為電子地圖選店本身不是金流／資料異動 API，
// 綠界官方文件裡這一步也沒有要求要驗簽章。

const FALLBACK_SITE_URL = 'https://www.fann-beauty.com';

// ✅ 客人從哪個網址來，就回到哪個網址（www / 不帶 www 在瀏覽器眼中是兩個不同的網站，
// 存在手機裡的購物車、名字、LINE 登入互不相通；回錯邊客人就會看到空的購物車或被要求重新登入）
const siteUrlOf = (req) => {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase().split(',')[0].trim();
    if (/^(www\.)?fann-beauty\.com$/.test(host) || /^[a-z0-9-]+\.vercel\.app$/.test(host)) return `https://${host}`;
    return process.env.SITE_URL || FALLBACK_SITE_URL;
};

module.exports = async function handler(req, res) {
    const SITE_URL = siteUrlOf(req);
    const body = req.body || {};

    const storeId = typeof body.CVSStoreID === 'string' ? body.CVSStoreID : '';
    const storeName = typeof body.CVSStoreName === 'string' ? body.CVSStoreName : '';
    const address = typeof body.CVSAddress === 'string' ? body.CVSAddress : '';
    const phone = typeof body.CVSTelephone === 'string' ? body.CVSTelephone : '';

    // ✅ 這三樣是官網那邊在導去選店之前，掛在 ServerReplyURL 網址上帶過來的（付款方式、
    // 客人手機、收件人姓名），跟綠界選店結果本身無關，這裡只是原封不動地接住、繼續往下傳
    // p 是 ecpay-logistics-map 放的付款方式代號（不讓 credit_card 這種字出現在給綠界的網址上），這裡換回原值；
    // pm 是舊版網址直接帶的寫法，還在路上的舊連結照樣接受
    const PM_FROM_CODE = { c: 'cvs_cod', k: 'credit_card', b: 'bank' };
    const pm = PM_FROM_CODE[typeof req.query.p === 'string' ? req.query.p : ''] || (typeof req.query.pm === 'string' ? req.query.pm : '');
    const custPhone = typeof req.query.custPhone === 'string' ? req.query.custPhone : '';
    const custReceiver = typeof req.query.custReceiver === 'string' ? req.query.custReceiver : '';
    const h = typeof req.query.h === 'string' && /^[A-Za-z0-9_-]{12,64}$/.test(req.query.h) ? req.query.h : '';

    if (!storeId) {
        // ✅ 客人在綠界頁面按上一頁/取消，沒有真的選店，就導回結帳頁，不帶門市參數
        // mf：沒拿到門市時，把「綠界是怎麼回來的」帶回官網記錄下來（POST/GET、帶了幾個欄位），方便之後查原因
        const mf = `${req.method || ''}_${Object.keys(body).length}`.replace(/[^A-Za-z0-9_]/g, '').slice(0, 20);
        res.writeHead(302, { Location: `${SITE_URL}/${h ? `?h=${h}&mf=${mf}${pm ? `&pm=${encodeURIComponent(pm)}` : ''}` : ''}` });
        res.end();
        return;
    }

    const params = new URLSearchParams({
        cvsStoreId: storeId,
        cvsStoreName: storeName,
        cvsAddress: address,
        cvsPhone: phone,
        ...(pm ? { pm } : {}),
        ...(custPhone ? { custPhone } : {}),
        ...(custReceiver ? { custReceiver } : {}),
        ...(h ? { h } : {})
    });

    res.writeHead(302, { Location: `${SITE_URL}/?${params.toString()}` });
    res.end();
};
