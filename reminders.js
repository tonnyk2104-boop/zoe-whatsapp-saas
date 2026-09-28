// קובץ: reminders.js

require('dotenv').config();
const cron = require('node-cron');
const db = require('./db');
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// בדיקה אם אנחנו בסביבת ייצור (Production)
const isProduction = process.env.NODE_ENV === 'production';

async function sendReminders() {
    console.log(`⏰ מתחיל תהליך שליחת תזכורות יומי... (סביבה: ${isProduction ? 'Production' : 'Development'})`);

    try {
        // 1. חישוב תאריך למחר
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dateStr = tomorrow.toISOString().split('T')[0];
        
        console.log(`בודק תורים לתאריך: ${dateStr}`);

        // 2. שליפת כל התורים למחר (מאושרים), מסודרים לפי טלפון
        const appointmentsRes = await db.pool.query(
            `SELECT a.AppointmentID, a.CustomerName, a.CustomerPhone, a.StartTime, s.ServiceName, b.BusinessName, b.WhatsAppNumber
             FROM Appointments_Log a
             JOIN Services s ON a.ServiceID = s.ServiceID
             JOIN Businesses b ON a.BusinessID = b.BusinessID
             WHERE DATE(a.StartTime) = $1 AND a.Status = 'Confirmed'
             ORDER BY a.CustomerPhone, a.StartTime`,
            [dateStr]
        );

        const appointments = appointmentsRes.rows;
        if (appointments.length === 0) {
            console.log('אין תורים למחר.');
            return;
        }

        // 3. קיבוץ תורים לפי לקוח (כדי לשלוח הודעה אחת מרוכזת)
        const groupedAppointments = {};
        
        appointments.forEach(appt => {
            // מפתח ייחודי: מספר הטלפון של הלקוח + העסק
            const key = `${appt.customerphone}_${appt.businessname}`;
            if (!groupedAppointments[key]) {
                groupedAppointments[key] = [];
            }
            groupedAppointments[key].push(appt);
        });

        // 4. שליחת הודעות
        for (const key in groupedAppointments) {
            const customerAppts = groupedAppointments[key];
            const firstAppt = customerAppts[0];
            const customerName = firstAppt.customername;
            const businessName = firstAppt.businessname;
            const customerPhone = firstAppt.customerphone;

            let messageBody = '';

            if (customerAppts.length === 1) {
                // --- תור יחיד ---
                const timeString = new Date(firstAppt.starttime).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
                messageBody = `היי ${customerName}! 👋
תזכורת לתורך מחר ב*${businessName}* בשעה ${timeString}.
טיפול: ${firstAppt.servicename}.

לאישור הגעה השב *כן*.
לביטול השב *ביטול*.`;

            } else {
                // --- ריבוי תורים ---
                messageBody = `היי ${customerName}! 👋
יש לך ${customerAppts.length} תורים מחר ב*${businessName}*:

`;
                customerAppts.forEach((appt, index) => {
                    const time = new Date(appt.starttime).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
                    messageBody += `${index + 1}. *${appt.servicename}* בשעה ${time}\n`;
                });

                messageBody += `
לאישור הגעה לכולם השב *כן*.
לביטול תור ספציפי, השב *ביטול* ואז את מספר התור.`;
            }

            // שליחה בפועל
            try {
                // שימוש במספר הטלפון הייעודי של העסק השולח
                const fromNumber = firstAppt.whatsappnumber || process.env.TWILIO_PHONE_NUMBER || 'whatsapp:+14155238886';
                
                if (!isProduction) {
                    console.log(`[DEV MODE] הודעה הייתה נשלחת מ-${fromNumber} ל-${customerPhone}:`);
                    console.log(messageBody);
                } else {
                    // ב-Production שולחים רגיל
                    await client.messages.create({
                        from: fromNumber, 
                        to: customerPhone,
                        body: messageBody
                    });
                    console.log(`✅ תזכורת נשלחה ל-${customerName} (${customerAppts.length} תורים)`);
                    
                    // עדכון מסד הנתונים שהתזכורת נשלחה כדי למנוע כפילויות במקרה של הפעלה מחדש
                    const appointmentIds = customerAppts.map(appt => appt.appointmentid);
                    await db.pool.query(
                        `UPDATE Appointments_Log SET ReminderSent = true WHERE AppointmentID = ANY($1::int[])`,
                        [appointmentIds]
                    );
                }
            } catch (e) {
                console.error(`❌ שגיאה בשליחה ל-${customerName}:`, e.message);
            }
        }
        
    } catch (err) {
        console.error('שגיאה בתהליך התזכורות:', err);
    }
}

// תזמון: כל יום ב-18:00 שעון ישראל
cron.schedule('0 18 * * *', () => {
    sendReminders();
}, { timezone: "Asia/Jerusalem" });

module.exports = { sendReminders };