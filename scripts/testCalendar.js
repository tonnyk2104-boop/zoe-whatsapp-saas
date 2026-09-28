const scheduler = require('./scheduler');

// --- הגדרות ---
const MY_CALENDAR_ID = 'tonnyk2104@gmail.com'; 
const TEST_DATE = '2025-12-10'; // נבדוק את ה-10 בדצמבר
const DURATION = 30; // טיפול של 30 דקות
const OPEN = '09:00';
const CLOSE = '12:00';

async function runTest() {
  console.log('--- מתחילים... ---');
  try {
    const slots = await scheduler.findFreeSlots(MY_CALENDAR_ID, TEST_DATE, DURATION, OPEN, CLOSE);
    console.log('\n📅 תוצאות: שעות פנויות שנמצאו:');
    console.log(slots);
  } catch (err) {
    console.error('שגיאה:', err);
  }
}

runTest();