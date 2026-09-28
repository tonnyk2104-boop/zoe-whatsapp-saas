const { google } = require('googleapis');
const path = require('path');

// --- הגדרות ---
const MY_CALENDAR_ID = 'tonnyk2104@gmail.com'; 
const CHECK_DATE = '2025-12-10'; 
// ----------------

const KEY_FILE_PATH = path.join(__dirname, 'google-key.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE_PATH, scopes: SCOPES });
const calendar = google.calendar({ version: 'v3', auth });

async function inspectDay() {
  console.log(`🕵️‍♂️ בודק מה קיים ביומן בתאריך ${CHECK_DATE}...`);
  
  const timeMin = new Date(`${CHECK_DATE}T00:00:00`).toISOString();
  const timeMax = new Date(`${CHECK_DATE}T23:59:59`).toISOString();

  try {
    const res = await calendar.events.list({
      calendarId: MY_CALENDAR_ID,
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items;
    
    if (events.length === 0) {
      console.log('❌ הבוט רואה 0 אירועים ביום הזה.');
      console.log('מסקנה: האירוע שיצרת נמצא ביומן אחר, או שה-ID לא נכון.');
    } else {
      console.log(`✅ הבוט מצא ${events.length} אירועים:`);
      events.forEach((event, i) => {
        const start = event.start.dateTime || event.start.date;
        console.log(`${i+1}. [${start}] - ${event.summary}`);
      });
    }

  } catch (err) {
    console.error('שגיאה:', err.message);
  }
}

inspectDay();