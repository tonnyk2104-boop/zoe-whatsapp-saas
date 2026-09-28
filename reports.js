// קובץ: reports.js

require('dotenv').config();
const cron = require('node-cron');
const db = require('./db');
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- פונקציית עזר לשליחה ---
async function sendToOwner(ownerPhone, message) {
    if (!ownerPhone) return;
    try {
        await client.messages.create({
            from: process.env.TWILIO_PHONE_NUMBER || 'whatsapp:+14155238886', 
            to: ownerPhone,
            body: message
        });
        console.log(`✅ דוח נשלח ל-${ownerPhone}`);
    } catch (e) {
        console.error(`❌ שגיאה בשליחת דוח:`, e.message);
    }
}

// --- 1. תדריך בוקר (Morning Brief) ---
async function sendMorningBrief() {
    console.log('🌅 מכין תדריך בוקר...');
    // מקבלים את התאריך הנוכחי בישראל
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD

    try {
        const businesses = await db.pool.query('SELECT BusinessID, BusinessName, OwnerPhone FROM Businesses WHERE OwnerPhone IS NOT NULL');

        // פתרון בעיית N+1: שליפת כל התורים של כל העסקים להיום בשאילתה אחת!
        const allAppts = await db.pool.query(
            `SELECT a.BusinessID, a.CustomerName, a.CustomerPhone, a.StartTime, s.ServiceName, a.ConfirmationStatus 
             FROM Appointments_Log a
             JOIN Services s ON a.ServiceID = s.ServiceID
             WHERE DATE(a.StartTime) = $1 AND a.Status = 'Confirmed'
             ORDER BY a.StartTime ASC`,
            [today]
        );

        for (const biz of businesses.rows) {
            // סינון הנתונים בזיכרון השרת (Memory) במקום להעמיס על מסד הנתונים
            const bizAppts = allAppts.rows.filter(appt => appt.businessid === biz.businessid);
            const confirmed = bizAppts.filter(appt => appt.confirmationstatus === 'Confirmed');
            const pending = bizAppts.filter(appt => appt.confirmationstatus === 'Pending');

            // בניית ההודעה
            let message = `בוקר טוב! ☀️\nתדריך ליום *${new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' })}* ב*${biz.businessname}*:\n\n`;

            if (confirmed.length === 0 && pending.length === 0) {
                message += "אין תורים רשומים להיום. יום חופש? 🏖️";
            } else {
                // --- חלק א': המאושרים ---
                if (confirmed.length > 0) {
                    message += `✅ *תורים מאושרים (${confirmed.length}):*\n`;
                    confirmed.forEach(appt => {
                        const time = new Date(appt.starttime).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
                        message += `• ${time} - ${appt.customername} (${appt.servicename})\n`;
                    });
                    message += '\n';
                }

                // --- חלק ב': הבעייתיים (לא אישרו) ---
                if (pending.length > 0) {
                    message += `⚠️ *לא אישרו הגעה (${pending.length}):*\n`;
                    pending.forEach(appt => {
                        const time = new Date(appt.starttime).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
                        message += `• ${time} - ${appt.customername}\n   📱 ${appt.customerphone} (${appt.servicename})\n`;
                    });
                    message += '\n📞 מומלץ ליצור איתם קשר!';
                }
            }

            await sendToOwner(biz.ownerphone, message);
        }
    } catch (err) {
        console.error('שגיאה בתדריך בוקר:', err);
    }
}

// --- 2. סיכום יום (Evening Summary) ---
async function sendEveningSummary() {
    console.log('🌙 מכין סיכום יום...');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

    try {
        const businesses = await db.pool.query('SELECT BusinessID, BusinessName, OwnerPhone FROM Businesses WHERE OwnerPhone IS NOT NULL');

        // פתרון בעיית N+1: קיבוץ הסטטיסטיקות של כל העסקים בבת אחת
        const statsRes = await db.pool.query(
            `SELECT 
                BusinessID,
                COUNT(*) FILTER (WHERE Status = 'Confirmed') as total_active,
                COUNT(*) FILTER (WHERE Status = 'Cancelled' AND DATE(StartTime) = $1) as cancelled_today,
                COUNT(*) FILTER (WHERE DATE(CreatedAt) = $1) as new_bookings_made_today
             FROM Appointments_Log 
             WHERE DATE(StartTime) = $1 OR DATE(CreatedAt) = $1
             GROUP BY BusinessID`,
            [today]
        );

        for (const biz of businesses.rows) {
            // מציאת השורה הרלוונטית לעסק הנוכחי, או איפוס ערכים אם אין נתונים
            const bizStats = statsRes.rows.find(s => s.businessid === biz.businessid) || { total_active: 0, cancelled_today: 0, new_bookings_made_today: 0 };
            const { total_active, cancelled_today, new_bookings_made_today } = bizStats;

            if (total_active == 0 && cancelled_today == 0 && new_bookings_made_today == 0) continue;

            const message = `סיכום יומי - *${biz.businessname}* 🌙\n
✅ תורים פעילים שהיו היום: ${total_active}
❌ ביטולים לתורים של היום: ${cancelled_today}
📅 תורים חדשים שנקבעו היום (לעתיד): ${new_bookings_made_today}

לילה טוב! 😴`;

            await sendToOwner(biz.ownerphone, message);
        }
    } catch (err) {
        console.error('שגיאה בסיכום יום:', err);
    }
}

// --- תזמונים ---
// בוקר: כל יום ב-08:00
cron.schedule('0 8 * * *', sendMorningBrief, { timezone: "Asia/Jerusalem" });

// ערב: כל יום ב-21:00
cron.schedule('0 21 * * *', sendEveningSummary, { timezone: "Asia/Jerusalem" });

module.exports = { sendMorningBrief, sendEveningSummary };