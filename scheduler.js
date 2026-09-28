// קובץ: scheduler.js
// גרסה: 4.2 - מנוע עגלת טיפולים חכם + תמיכה בשלבי המתנה + שחזור פונקציות ביטול + תיקון UX ליום ריק + מנגנון Rollback וסימולטור

const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

let calendar = null;
try {
    const authParams = { scopes: ['https://www.googleapis.com/auth/calendar'] };
    
    if (process.env.GOOGLE_CREDENTIALS) {
        authParams.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } else {
        const KEY_FILE_PATH = path.join(__dirname, 'google-key.json');
        if (fs.existsSync(KEY_FILE_PATH)) {
            authParams.keyFile = KEY_FILE_PATH;
        } else {
            throw new Error("Credentials file not found");
        }
    }
    
    const auth = new google.auth.GoogleAuth(authParams);
    calendar = google.calendar({ version: 'v3', auth });
} catch (e) {
    console.warn("⚠️ אזהרה (Scheduler): לא נמצאו הרשאות ל-Google Calendar. המערכת תרוץ במצב 'סימולטור' ללא סנכרון אמיתי.");
}

/**
 * מנרמל את מבנה זמן הטיפול למערך אחיד (תומך בשלבי עבודה והמתנה)
 */
function normalizeDuration(durationData) {
    if (Array.isArray(durationData)) return durationData;
    if (typeof durationData === 'number') return [{ type: 'work', duration: durationData }];
    if (typeof durationData === 'string') return [{ type: 'work', duration: parseInt(durationData) }];
    return [{ type: 'work', duration: 30 }]; // ברירת מחדל
}

function getIsraelTime(dateStr, timeStr) {
    if (!timeStr) timeStr = "09:00"; 
    let hours = 9, minutes = 0;
    
    if (timeStr.includes(':')) {
        const parts = timeStr.split(':');
        hours = parseInt(parts[0]) || 0;
        minutes = parseInt(parts[1]) || 0;
    }

    let localDate;
    if (dateStr && dateStr.includes('-')) {
        const [year, month, day] = dateStr.split('-');
        localDate = new Date(year, month - 1, day, hours, minutes, 0, 0);
    } else {
        localDate = new Date(dateStr);
        localDate.setHours(hours, minutes, 0, 0);
    }
    return localDate;
}

function formatTime(dateObj) {
    const hh = String(dateObj.getHours()).padStart(2, '0');
    const mm = String(dateObj.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

async function getEventsForCalendar(calId, timeMin, timeMax) {
    if (!calendar) return []; // סימולטור: מניח שהיומן תמיד פנוי
    try {
        const res = await calendar.events.list({
            calendarId: calId,
            timeMin: timeMin,
            timeMax: timeMax,
            singleEvents: true,
            orderBy: 'startTime',
            timeZone: 'Asia/Jerusalem'
        });
        return res.data.items || [];
    } catch (e) {
        console.error(`Error fetching calendar ${calId}:`, e.message);
        return [];
    }
}

/**
 * פונקציית אלגוריתם ה"טטריס": משבצת עגלה שלמה, תומכת ב-Max Gap ומתעלמת מ-Wait Segments בבדיקת תפוסה
 */
function placeCart(cart, startTime, maxGapMinutes, busySlots, endSearchTime) {
    let currentAttemptTime = new Date(startTime);
    let placements = []; 

    for (let i = 0; i < cart.length; i++) {
        const service = cart[i];
        const steps = normalizeDuration(service.durationdata || 30);
        let servicePlaced = false;
        
        // הטיפול הראשון בעגלה חייב להתחיל בדיוק בזמן שניסינו. לטיפולים הבאים מותר לחכות עד maxGap
        const maxGapAllowed = (i === 0) ? 0 : maxGapMinutes; 
        
        // קפיצות של 5 דקות כדי למצוא את החור הראשון הפנוי בתוך החלון הסביל
        for (let gap = 0; gap <= maxGapAllowed; gap += 5) { 
            let tryStartTime = new Date(currentAttemptTime.getTime() + gap * 60000);
            let serviceValid = true;
            let tempCursor = new Date(tryStartTime);
            let serviceStepsPlacement = [];

            for (let j = 0; j < steps.length; j++) {
                const step = steps[j];
                const stepEndTime = new Date(tempCursor.getTime() + step.duration * 60000);

                if (stepEndTime > endSearchTime) {
                    serviceValid = false;
                    break; // חורג משעות הפעילות
                }

                if (step.type === 'work') {
                    const isBusy = busySlots.some(busy => (tempCursor < busy.end && stepEndTime > busy.start));
                    if (isBusy) {
                        serviceValid = false;
                        break;
                    }
                    serviceStepsPlacement.push({ type: 'work', start: tempCursor, end: stepEndTime });
                } else {
                    // שלב המתנה (Wait) - מקדמים את הזמן אבל לא בודקים תפוסה ביומן!
                    serviceStepsPlacement.push({ type: 'wait', start: tempCursor, end: stepEndTime });
                }
                
                tempCursor = stepEndTime;
            }

            if (serviceValid) {
                servicePlaced = true;
                placements.push({
                    service: service,
                    start: tryStartTime,     // התחלה של כל הטיפול המורכב
                    end: tempCursor,         // סיום של כל הטיפול
                    steps: serviceStepsPlacement // פירוט השלבים לכתיבה ליומן
                });
                currentAttemptTime = tempCursor; // הטיפול הבא בעגלה יתחיל מסיום הטיפול הזה
                break;
            }
        }

        if (!servicePlaced) return null; // אם טיפול אחד מהעגלה לא נכנס, הכל נפסל לשעה הזו
    }
    return placements;
}

/**
 * סריקת היומן ומציאת שעות פנויות לעגלה שלמה
 */
async function findFreeSlots(mainCalendarId, otherCalendarsStr, dateStr, cart, openTime, closeTime, maxGapMinutes = 20) {
    let normalizedCart = Array.isArray(cart) ? cart : [{ servicename: 'טיפול', durationdata: parseInt(cart) || 30 }];
    
    let otherCalendars = [];
    if (otherCalendarsStr && typeof otherCalendarsStr === 'string') {
        otherCalendars = otherCalendarsStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
    }
    const allCalendarsToCheck = [mainCalendarId, ...otherCalendars];

    const startSearchTime = getIsraelTime(dateStr, openTime);
    const endSearchTime = getIsraelTime(dateStr, closeTime);

    const eventsPromises = allCalendarsToCheck.map(calId => 
        getEventsForCalendar(calId, startSearchTime.toISOString(), endSearchTime.toISOString())
    );
    const eventsResults = await Promise.all(eventsPromises);
    
    const busySlots = eventsResults.flat().map(event => ({
        start: new Date(event.start.dateTime || event.start.date),
        end: new Date(event.end.dateTime || event.end.date)
    })).sort((a, b) => a.start - b.start);

    const now = new Date();
    const reqDate = new Date(dateStr);
    let searchCursor = new Date(startSearchTime);

    const isToday = (reqDate.getDate() === now.getDate() && reqDate.getMonth() === now.getMonth() && reqDate.getFullYear() === now.getFullYear());
    if (isToday) {
        const bufferTime = new Date(now.getTime() + 60 * 60 * 1000); 
        if (bufferTime > searchCursor) {
            searchCursor = bufferTime;
            const remainder = 15 - (searchCursor.getMinutes() % 15);
            if (remainder !== 15) searchCursor.setMinutes(searchCursor.getMinutes() + remainder);
            searchCursor.setSeconds(0);
            searchCursor.setMilliseconds(0);
        }
    }

    const regularSlots = [];
    const prioritySlots = [];

    while (searchCursor < endSearchTime) {
        const placements = placeCart(normalizedCart, searchCursor, maxGapMinutes, busySlots, endSearchTime);

        if (placements) {
            let gapAfter = 999;
            let gapBefore = 999;
            
            const firstSlotStart = placements[0].start;
            const lastSlotEnd = placements[placements.length - 1].end;

            if (busySlots.length > 0) {
                const nextEvent = busySlots.find(e => e.start >= lastSlotEnd);
                if (nextEvent) gapAfter = Math.floor((nextEvent.start - lastSlotEnd) / 60000);
                else gapAfter = Math.floor((endSearchTime - lastSlotEnd) / 60000);

                const prevEvent = [...busySlots].reverse().find(e => e.end <= firstSlotStart);
                if (prevEvent) gapBefore = Math.floor((firstSlotStart - prevEvent.end) / 60000);
                else gapBefore = Math.floor((firstSlotStart - startSearchTime) / 60000);
            }

            const timeString = formatTime(searchCursor);
            let isPriority = (gapBefore >= 0 && gapBefore <= 10) || (gapAfter >= 0 && gapAfter <= 10);

            // התיקון: התנהגות חכמה ליום ריק לחלוטין (מונע הצפה של שעות למשתמש בווטסאפ)
            if (busySlots.length === 0) {
                // נמליץ רק על שעות עגולות (00:) וחצאי שעות (30:) כשהיום ריק
                isPriority = timeString.endsWith(':00') || timeString.endsWith(':30');
            }

            if (isPriority) prioritySlots.push(timeString);
            else regularSlots.push(timeString);
        }
        
        searchCursor = new Date(searchCursor.getTime() + 15 * 60000);
    }

    return { 
        prioritySlots: [...new Set(prioritySlots)].sort(),
        regularSlots: [...new Set(regularSlots)].sort()
    };
}

/**
 * כתיבת העגלה ליומן - מדלג על זמני המתנה (Wait) ורושם רק זמני עבודה (Work)!
 */
async function bookAppointment(calendarId, otherCalendarsStr, dateStr, timeStr, cart, customerPhone, customerName = 'לקוח', maxGapMinutes = 20) {
    let normalizedCart = Array.isArray(cart) ? cart : [{ servicename: cart, durationdata: 30 }];
    const requestedStartTime = getIsraelTime(dateStr, timeStr);
    const endDay = getIsraelTime(dateStr, "23:59");

    let otherCalendars = [];
    if (otherCalendarsStr && typeof otherCalendarsStr === 'string') otherCalendars = otherCalendarsStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
    const allCalendarsToCheck = [calendarId, ...otherCalendars];
    
    const eventsPromises = allCalendarsToCheck.map(calId => getEventsForCalendar(calId, getIsraelTime(dateStr, "00:00").toISOString(), endDay.toISOString()));
    const eventsResults = await Promise.all(eventsPromises);
    const busySlots = eventsResults.flat().map(e => ({ start: new Date(e.start.dateTime || e.start.date), end: new Date(e.end.dateTime || e.end.date) })).sort((a, b) => a.start - b.start);

    const placements = placeCart(normalizedCart, requestedStartTime, maxGapMinutes, busySlots, endDay);
    if (!placements) return { success: false, message: 'Time slots no longer available' };

    const bookedEvents = [];
    let mainEventId = null;
    let insertedEventIds = []; // מערך לשמירת מזהים למקרה של Rollback (ביטול פעולה)

    try {
        for (let i = 0; i < placements.length; i++) {
            const p = placements[i];
            let serviceEventIds = []; // נשמור את כל הבלוקים של אותו טיפול
            
            for (let j = 0; j < p.steps.length; j++) {
                const step = p.steps[j];
                
                // כותבים ליומן רק שלבי 'work'. מתעלמים משלבי 'wait'!
                if (step.type === 'work') {
                    const event = {
                        summary: `💇‍♂️ ${p.service.servicename} - ${customerName} (${i+1}/${placements.length})`,
                        description: `נקבע ע"י ZOE\nלקוח: ${customerName}\nטלפון: ${customerPhone}\nטיפול: ${i+1}/${placements.length}`,
                        start: { dateTime: step.start.toISOString(), timeZone: 'Asia/Jerusalem' },
                        end: { dateTime: step.end.toISOString(), timeZone: 'Asia/Jerusalem' },
                    };
                    
                    let eventId = 'mock_id_' + Math.random().toString(36).substr(2, 9);
                    if (calendar) {
                        const response = await calendar.events.insert({ calendarId: calendarId, resource: event });
                        eventId = response.data.id;
                    } else {
                        console.log(`[SIMULATOR] Mock booked event: ${event.summary} at ${event.start.dateTime}`);
                    }
                    
                    if (mainEventId === null) mainEventId = eventId;
                    serviceEventIds.push(eventId);
                    insertedEventIds.push(eventId); // שומרים את ה-ID למקרה שנצטרך לבצע Rollback
                } else {
                    console.log(`Log: Skipping WAIT segment (${(step.end - step.start)/60000} min) for Calendar.`);
                }
            }
            
            bookedEvents.push({
                serviceId: p.service.serviceid || p.service.ServiceID,
                serviceName: p.service.servicename,
                start: p.start, // התחלה כוללת (לשמירה ב-DB)
                end: p.end,     // סיום כולל (לשמירה ב-DB)
                eventId: serviceEventIds.join(',') // מזהי גוגל מחוברים בפסיק
            });
        }
        return { success: true, mainEventId: mainEventId, bookedEvents: bookedEvents };

    } catch (err) {
        console.error('❌ Error booking appointment (Initiating Rollback):', err.message);
        
        // Rollback: מחיקת כל הבלוקים "היתומים" שכבר יצרנו בהצלחה בגוגל בסיבוב הנוכחי לפני הקריסה
        for (const id of insertedEventIds) {
            try {
                if (calendar) {
                    await calendar.events.delete({ calendarId: calendarId, eventId: id });
                    console.log(`Rollback: Deleted orphaned event ${id}`);
                }
            } catch (delErr) {
                console.error(`Rollback Error: Could not delete orphaned event ${id}`);
            }
        }
        
        return { success: false, message: 'חלק מהתורים נכשלו מול יומן גוגל, הפעולה בוטלה.' };
    }
}

/**
 * פונקציות ניהול יומן נוספות שהוחזרו מהגרסאות הקודמות
 */
async function cancelAppointment(calendarId, eventId) {
    if (!eventId) return false;
    if (!calendar) return true; // סימולטור מתעלם מביטול בגוגל
    try {
        // במידה ויש מספר מזהים מחוברים בפסיק (פיצול עגלה), נבטל את כולם
        const eventIds = eventId.split(',');
        for (const id of eventIds) {
            await calendar.events.delete({ calendarId: calendarId, eventId: id.trim() });
        }
        return true;
    } catch (err) {
        console.error('Error canceling appointment:', err.message);
        return true; // מחזירים true גם בשגיאה כדי לא לתקוע את מסד הנתונים במידה והאירוע נמחק ידנית
    }
}

// הייצוא המעודכן ללא קוד מת
module.exports = { findFreeSlots, bookAppointment, cancelAppointment };