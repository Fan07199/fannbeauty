// Vercel Serverless Function: POST /api/notify
// 讓賣家後台 (admin.html) 直接推播 LINE 訊息給已綁定 LINE 登入的客人。
// 密鑰只存在 Vercel 專案的環境變數，不會出現在前端程式碼或 git 歷史裡：
//   LINE_CHANNEL_ACCESS_TOKEN  — LINE Messaging API 頻道的 Channel access token (long-lived)
//   ADMIN_NOTIFY_KEY           — 與 admin.html 裡 ADMIN_NOTIFY_KEY 常數相同的共用密鑰

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const adminKey = req.headers['x-admin-key'];
    if (!process.env.ADMIN_NOTIFY_KEY || adminKey !== process.env.ADMIN_NOTIFY_KEY) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }

    const { lineUserId, message } = req.body || {};
    if (!lineUserId || typeof lineUserId !== 'string') {
        res.status(400).json({ error: 'Missing lineUserId' });
        return;
    }
    if (!message || typeof message !== 'string' || message.length === 0 || message.length > 2000) {
        res.status(400).json({ error: 'Invalid message' });
        return;
    }

    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!token) {
        res.status(500).json({ error: 'Server not configured: missing LINE_CHANNEL_ACCESS_TOKEN' });
        return;
    }

    try {
        const lineRes = await fetch('https://api.line.me/v2/bot/message/push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                to: lineUserId,
                messages: [{ type: 'text', text: message }]
            })
        });

        if (!lineRes.ok) {
            const detail = await lineRes.text();
            res.status(lineRes.status).json({ error: 'LINE push failed', detail });
            return;
        }

        res.status(200).json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Push failed', detail: String(err) });
    }
};
