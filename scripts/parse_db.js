// --- הדבק את הכתובת הארוכה מ-Render בין הגרשיים למטה ---
const connectionString = 'postgresql://tonny:wJ3CozVUYmB1WROW7m27uGtTpNhEnEii@dpg-d4okfa7gi27c738igbog-a.frankfurt-postgres.render.com/whatsapp_bot_platform'; 
// -----------------------------------------------------------

function parseDatabaseUrl(url) {
    if (!url || url.includes('הדבק-כאן')) {
        console.error('❌ שגיאה: לא הדבקת את הכתובת האמיתית מ-Render.');
        return null;
    }

    // ניקוי רווחים מיותרים מההתחלה והסוף (נפוץ מאוד בהעתקה)
    const cleanUrl = url.trim();
    
    console.log(`🔍 מנסה לפענח את הכתובת: "${cleanUrl}"`);

    try {
        const parsedUrl = new URL(cleanUrl);
        
        let dbName = parsedUrl.pathname;
        if (dbName.startsWith('/')) {
            dbName = dbName.substring(1);
        }

        return {
            host: parsedUrl.hostname,
            user: parsedUrl.username,
            password: parsedUrl.password,
            database: dbName,
            port: parsedUrl.port || '5432',
            ssl: 'true'
        };
    } catch (error) {
        console.error('❌ שגיאת פענוח:', error.message);
        return null;
    }
}

const config = parseDatabaseUrl(connectionString);

if (config) {
    console.log('\n✅ הכתובת פוענחה בהצלחה! העתק את הערכים הבאים ל-Render:\n');
    console.log('--------------------------------------');
    console.log(`DB_HOST:      ${config.host}`);
    console.log(`DB_USER:      ${config.user}`);
    console.log(`DB_PASSWORD:  ${config.password}`);
    console.log(`DB_DATABASE:  ${config.database}`);
    console.log(`DB_PORT:      ${config.port}`);
    console.log(`DB_SSL:       ${config.ssl}`);
    console.log('--------------------------------------\n');
} else {
    console.log('\nטיפ: וודא שהכתובת מתחילה ב-postgres:// ואין רווחים באמצע.');
}