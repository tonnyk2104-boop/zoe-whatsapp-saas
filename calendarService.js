// קובץ: calendarService.js

const { google } = require('googleapis');
const path = require('path');

// הגדרת הרשאות (אנחנו צריכים לקרוא ולכתוב)
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// התחברות חכמה: תמיכה במשתני סביבה (לפרודקשן) או קובץ מקומי (לפיתוח)
let auth;
if (process.env.GOOGLE_CREDENTIALS) {
  // בסביבת ענן: טעינת המפתח מתוך משתנה סביבה (JSON בצורת String)
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  auth = new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
  });
} else {
  // בסביבה מקומית: טעינה מהקובץ (חובה לוודא שקובץ זה מופיע ב-.gitignore!)
  const KEY_FILE_PATH = path.join(__dirname, 'google-key.json');
  auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE_PATH,
    scopes: SCOPES,
  });
}

const calendar = google.calendar({ version: 'v3', auth });

// פונקציה לבדיקה ראשונית: שליפת האירועים הבאים
async function listNextEvents(calendarId) {
  try {
    const res = await calendar.events.list({
      calendarId: calendarId,
      timeMin: new Date().toISOString(), // החל מעכשיו
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items;
    if (!events || events.length === 0) {
      console.log('✅ החיבור הצליח, אבל לא נמצאו אירועים קרובים ביומן.');
      return;
    }

    console.log('✅ החיבור הצליח! הנה 10 האירועים הבאים שלך:');
    events.map((event, i) => {
      const start = event.start.dateTime || event.start.date;
      console.log(`${i + 1}. ${start} - ${event.summary}`);
    });

  } catch (error) {
    console.error('❌ שגיאה בחיבור ליומן:', error.message);
    console.error('טיפ: האם שיתפת את היומן עם האימייל של הבוט?');
  }
}

module.exports = { listNextEvents };