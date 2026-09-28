const { google } = require('googleapis');
const path = require('path');

const KEY_FILE_PATH = path.join(__dirname, 'google-key.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE_PATH, scopes: SCOPES });
const calendar = google.calendar({ version: 'v3', auth });

async function listMyCalendars() {
  console.log('🕵️‍♂️ בודק לאילו יומנים יש לבוט גישה...');
  
  try {
    const res = await calendar.calendarList.list();
    const calendars = res.data.items;

    if (calendars.length === 0) {
      console.log('❌ הבוט לא רואה שום יומן! (האם עשית "Share" לאימייל של הבוט?)');
    } else {
      console.log('✅ הבוט מחובר ליומנים הבאים:');
      calendars.forEach(cal => {
        console.log(`-----------------------------------`);
        console.log(`📌 שם היומן: ${cal.summary}`);
        console.log(`🆔 מזהה (Calendar ID): ${cal.id}`);
        console.log(`🔑 רמת גישה: ${cal.accessRole}`);
      });
    }
  } catch (err) {
    console.error('שגיאה:', err.message);
  }
}

listMyCalendars();