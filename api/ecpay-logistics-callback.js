// Vercel Serverless Function: POST /api/ecpay-logistics-callback
// 綠界電子地圖選店完成後，會把客人的瀏覽器導到這裡（ServerReplyURL），
// 帶著客人選好的 7-11 門市資訊（POST 表單）。這支只是把資訊接住、
// 轉成網址參數，再把客人導回官網結帳頁，官網那邊會自動讀出來顯示。
//
// 不需要驗證 CheckMacValue，因為電子地圖選店本身不是金流／資料異動 API，
// 綠界官方文件裡這一步也沒有要求要驗簽章。

const FALLBACK_SITE_URL = 'https://www.fann-beauty.com';

module.exports = async function handler(req, res) {
    const SITE_URL = process.env.SITE_URL || (req.headers.host ? `https://${req.headers.host}` : FALLBACK_SITE_URL);
    const body = req.body || {};

    const storeId = typeof body.CVSStoreID === 'string' ? body.CVSStoreID : '';
    const storeName = typeof body.CVSStoreName === 'string' ? body.CVSStoreName : '';
    const address = typeof body.CVSAddress === 'string' ? body.CVSAddress : '';
    const phone = typeof body.CVSTelephone === 'string' ? body.CVSTelephone : '';

    if (!storeId) {
        // ✅ 客人在綠界頁面按上一頁/取消，沒有真的選店，就導回結帳頁，不帶門市參數
        res.writeHead(302, { Location: `${SITE_URL}/` });
        res.end();
        return;
    }

    const params = new URLSearchParams({
        cvsStoreId: storeId,
        cvsStoreName: storeName,
        cvsAddress: address,
        cvsPhone: phone
    });

    res.writeHead(302, { Location: `${SITE_URL}/?${params.toString()}` });
    res.end();
};
