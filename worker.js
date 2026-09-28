// קובץ: worker.js
// מנוע האוטומציה השקט של ZOE - שליחת הודעות לפני ואחרי טיפול וניהול רשימות המתנה

require('dotenv').config();
const cron = require('node-cron');
const db = require('./db');
const twilio = require('twilio');
const scheduler = require('./scheduler'); // מנוע ה-scheduler לבדיקת תורים פנויים

// שימוש בערכי דמי (Dummy) אם אין מפתחות כדי למנוע קריסת שרת אצל המראיין
const client = twilio(
    process.env.TWILIO_ACCOUNT_SID || 'AC_dummy_account_sid', 
    process.env.TWILIO_AUTH_TOKEN || 'dummy_auth_token'
);

/**
 * פונקציית עזר להחלפת תגים דינמיים בטקסט
 */
function parseTemplate(template, appointmentData) {
    let result = template;
    result = result.replace(/{CustomerName}/g, appointmentData.customername || '');
    result = result.replace(/{ServiceName}/g, appointmentData.combined_services || 'הטיפול');
    result = result.replace(/{Date}/g, new Date(appointmentData.starttime).toLocaleDateString('he-IL'));
    result = result.replace(/{Time}/g, new Date(appointmentData.starttime).toLocaleTimeString('he-IL', {hour: '2-digit', minute:'2-digit'}));
    result = result.replace(/{StaffName}/g, appointmentData.staffname || 'הצוות שלנו');
    return result;
}

/**
 * משימת הרקע העיקרית: הודעות אוטומטיות (לפני/אחרי טיפול)
 */
async function processAutomatedMessages() {
    console.log(`[${new Date().toLocaleTimeString()}] Worker: Scanning for automated messages...`);
    
    try {
        // 1. שליפת כל חוקי האוטומציה הפעילים (הודעות שמוגדרות במערכת)
        const rulesRes = await db.pool.query('SELECT * FROM Automated_Messages WHERE IsActive = TRUE');
        const rules = rulesRes.rows;

        if (rules.length === 0) return;

        // 2. שליפת תורים פוטנציאליים (מכילים את המידע הנלווה כמו עובד ומיקום)
        // אנחנו מקבצים את התורים של אותו לקוח באותה שעה (עגלה) כדי למנוע ספאם!
        const appointmentsRes = await db.pool.query(`
            SELECT 
                a.BusinessID, a.CustomerPhone, a.CustomerName, 
                MIN(a.StartTime) as starttime, MAX(a.EndTime) as endtime, 
                STRING_AGG(s.ServiceName, ', ') as combined_services,
                st.StaffName, a.GoogleCalendarEventID,
                b.WhatsAppNumber
            FROM Appointments_Log a
            LEFT JOIN Services s ON a.ServiceID = s.ServiceID
            LEFT JOIN Staff st ON a.StaffID = st.StaffID
            JOIN Businesses b ON a.BusinessID = b.BusinessID
            WHERE a.Status = 'Confirmed'
            GROUP BY a.BusinessID, a.CustomerPhone, a.CustomerName, st.StaffName, a.GoogleCalendarEventID, b.WhatsAppNumber
        `);
        
        const appointments = appointmentsRes.rows;
        const now = new Date();

        // 3. הצלבת חוקים מול תורים
        for (let appt of appointments) {
            for (let rule of rules) {
                // בדיקה האם החוק שייך לעסק של התור
                if (rule.businessid !== appt.businessid) continue;

                let targetTime;
                // חישוב מתי ההודעה אמורה להישלח
                if (rule.triggertype === 'PRE_APPOINTMENT') {
                    // לפני התור (האופסט בדרך כלל שלילי, למשל -1440 ל-24 שעות לפני)
                    targetTime = new Date(new Date(appt.starttime).getTime() + (rule.offsetminutes * 60000));
                } else if (rule.triggertype === 'POST_APPOINTMENT') {
                    // אחרי התור (האופסט חיובי, למשל 120 לשעתיים אחרי סיום)
                    targetTime = new Date(new Date(appt.endtime).getTime() + (rule.offsetminutes * 60000));
                }

                // האם הגיע הזמן לשלוח? (נותנים מרווח של 15 דקות מהזמן הרצוי כדי שהבוט יתפוס את זה בסיבובים שלו)
                const timeDiffMinutes = (now - targetTime) / 60000;
                
                if (timeDiffMinutes >= 0 && timeDiffMinutes <= 15) {
                    
                    // מניעת כפילויות בסביבת Cluster בעזרת ON CONFLICT
                    const insertCheck = await db.pool.query(
                        `INSERT INTO Sent_Automated_Messages (GoogleEventID, MessageID) 
                         VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *`,
                        [appt.googlecalendareventid, rule.messageid]
                    );

                    // אם השורה הוכנסה בהצלחה (כלומר לא נשלחה עדיין)
                    if (insertCheck.rows.length > 0) {
                        const finalMessage = parseTemplate(rule.messagetemplate, appt);
                        const fromNumber = appt.whatsappnumber || process.env.TWILIO_PHONE_NUMBER || 'whatsapp:+14155238886';
                        
                        try {
                            await client.messages.create({
                                from: fromNumber,
                                to: appt.customerphone,
                                body: finalMessage
                            });
                            console.log(`✅ Sent automated CRM message to ${appt.customername} (${rule.triggertype})`);
                        } catch (twErr) {
                            console.error(`❌ Failed to send CRM message to ${appt.customerphone}:`, twErr.message);
                            // במקרה של כישלון מול Twilio, נמחק את הרישום כדי לאפשר ניסיון חוזר בסבב הבא
                            await db.pool.query(
                                `DELETE FROM Sent_Automated_Messages WHERE GoogleEventID = $1 AND MessageID = $2`,
                                [appt.googlecalendareventid, rule.messageid]
                            );
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.error('❌ Worker Error:', err.message);
    }
}

/**
 * משימה: סריקת רשימות המתנה והצעת תורים
 */
async function processWaitingList() {
    console.log(`[${new Date().toLocaleTimeString()}] Worker: Scanning waiting lists...`);
    
    try {
        // 1. שליפת כל הלקוחות שממתינים לתור עתידי
        // (הנחה: יש טבלה WaitingList עם BusinessID, CustomerPhone, CustomerName, RequestedDate, RequestedTime, ServiceID, IsNotified)
        const waitingRes = await db.pool.query(`
            SELECT w.*, s.DurationData, p.GoogleCalendarID, p.Blocked_Calendars, b.WhatsAppNumber
            FROM WaitingList w
            JOIN Services s ON w.ServiceID = s.ServiceID
            JOIN Business_Profile p ON w.BusinessID = p.BusinessID
            JOIN Businesses b ON w.BusinessID = b.BusinessID
            WHERE w.RequestedDate >= CURRENT_DATE AND w.IsNotified = FALSE
        `);
        
        const waitingCustomers = waitingRes.rows;

        for (let waiter of waitingCustomers) {
            // הגנה מפני חסימה (Rate Limit) של Google API - המתנה קצרה בין בדיקות
            await new Promise(resolve => setTimeout(resolve, 500)); 

            // 2. בדיקה מול מנוע היומן (scheduler) האם יש חור פנוי באותו יום!
            const dateStr = new Date(waiter.requesteddate).toISOString().split('T')[0];
            
            // --- תחילת התיקון: חישוב נכון של משך הטיפול ממערך השלבים ---
            let totalDuration = 30;
            if (Array.isArray(waiter.durationdata)) {
                totalDuration = waiter.durationdata.reduce((sum, step) => sum + (parseInt(step.duration) || 0), 0);
            } else if (typeof waiter.durationdata === 'object' && waiter.durationdata !== null) {
                totalDuration = parseInt(waiter.durationdata.duration) || 30;
            } else {
                totalDuration = parseInt(waiter.durationdata) || 30;
            }
            
            // שולחים בקשה שקטה לאלגוריתם שלנו לבדוק אם יש מקום
            const slots = await scheduler.findFreeSlots(
                waiter.googlecalendarid, 
                waiter.blocked_calendars, 
                dateStr, 
                [{ durationdata: totalDuration }], // העברת עגלה מדומה עם הזמן המחושב
                '09:00', '20:00', 
                0 
            );

            const allSlots = [...slots.prioritySlots, ...slots.regularSlots];

            // 3. אם מצאנו חור שמתאים פחות או יותר לשעה שהוא רצה
            if (allSlots.length > 0) {
                // נחפש אם השעה המדויקת שלו התפנתה, או נציע לו שעה אחרת
                const availableTime = allSlots.includes(waiter.requestedtime) ? waiter.requestedtime : allSlots[0];

                // 4. שליחת ההודעה ללקוח
                const msg = `היי ${waiter.customername}! 🎉\nהתפנה מקום ביומן ב-${dateStr} בשעה ${availableTime}.\nרוצה לתפוס אותו?\nהשב *כן* כדי שאקבע לך את התור, או התעלם אם זה כבר לא רלוונטי.`;
                
                const fromNumber = waiter.whatsappnumber || process.env.TWILIO_PHONE_NUMBER || 'whatsapp:+14155238886';
                await client.messages.create({
                    from: fromNumber,
                    to: waiter.customerphone,
                    body: msg
                });

                // 5. סימון שהודענו ללקוח כדי לא לספים אותו שוב ושוב
                await db.pool.query('UPDATE WaitingList SET IsNotified = TRUE, OfferedTime = $1 WHERE WaitID = $2', [availableTime, waiter.waitid]);
                console.log(`✅ Sent Waitlist alert to ${waiter.customername} for ${dateStr} ${availableTime}`);
            }
        }

    } catch (err) {
        console.error('❌ Waitlist Worker Error:', err.message);
    }
}

// הגדרת השעון המעורר: רץ כל 5 דקות
// מריץ את שתי המשימות יחד באופן אסינכרוני
cron.schedule('*/5 * * * *', async () => {
    await processAutomatedMessages();
    await processWaitingList();
});

console.log('🤖 ZOE CRM Worker initialized. Scanning every 5 minutes.');

