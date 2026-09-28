const { google } = require('googleapis');
const path = require('path');

// --- חובה: הכנס כאן את האימייל שלך ---
const TARGET_CALENDAR_ID = 'tonnyk2104@gmail.com';
// -------------------------------------

const KEY_FILE_PATH = path.join(__dirname, 'google-key.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE_PATH, scopes: SCOPES });
const calendar = google.calendar({ version: 'v3', auth });

async function forceRead() {
  console.log(`🔨 מנסה לקרוא בכוח את היומן: ${TARGET_CALENDAR_ID}...`);
  
  try {
    // מנסים לקרוא אירועים (לא משנה מתי, העיקר שיצליח לגשת)
    const res = await calendar.events.list({
      calendarId: TARGET_CALENDAR_ID,
      maxResults: 1, // רק אחד כדי לראות שזה עובד
    });

    console.log('🎉 הצלחה! יש גישה ליומן הזה.');
    console.log('זה אומר שהשיתוף עובד, גם אם הרשימה הכללית הייתה ריקה.');

  } catch (err) {
    console.error('❌ כישלון.');
    console.error('הודעת השגיאה המלאה:', err.message);
    
    if (err.message.includes('Not Found')) {
      console.log('--- אבחנה: ה-ID שגוי או שהשיתוף לא בוצע לאימייל הנכון ---');
    }
    if (err.message.includes('403') || err.message.includes('Forbidden')) {
      console.log('--- אבחנה: ה-ID נכון, אבל לבוט אין הרשאה להיכנס (שיתוף לא תפס) ---');
    }
  }
}

forceRead();