// קובץ: index.js
// גרסה: 6.9.3 - הוספת Seeding, תיקון לקוח חדש, Rate Limiting מותאם לטוויליו ושיפור לוגיקת התחברות

require('dotenv').config();
require('./worker.js'); 

// וידוא משתני סביבה קריטיים בעליית השרת (Fail-Fast)
const requiredEnvVars = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'];
requiredEnvVars.forEach(envVar => {
    if (!process.env[envVar]) {
        console.error(`🚨 Fatal Error: Missing required environment variable: ${envVar}`);
        process.exit(1); // עוצר את השרת מיידית אם חסר מפתח קריטי
    }
});

const express = require('express');
const session = require('express-session');
const twilio = require('twilio');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors'); 
const bcrypt = require('bcrypt'); // הוספת ספריית ההצפנה
const db = require('./db');
const path = require('path');
const scheduler = require('./scheduler');

// טעינת מודולים אופציונליים למניעת קריסה אם חסרים
try { require('./reports'); require('./reminders'); } catch (e) { }

const app = express();
const port = process.env.PORT || 3000;
const SYSTEM_WHATSAPP_NUMBER = process.env.TWILIO_PHONE_NUMBER || 'whatsapp:+14155238886';
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.set('trust proxy', 1);

// הגדרת CORS מחמירה יותר לסביבת פרודקשן
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? (process.env.CLIENT_URL || false) : '*',
    credentials: true // מאפשר העברת עוגיות (Session) בצורה בטוחה
}));

app.use(helmet({ contentSecurityPolicy: false })); 
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
    console.warn('⚠️ אזהרת אבטחה: SESSION_SECRET אינו מוגדר בקובץ ה-.env!');
}

app.use(session({
    secret: process.env.SESSION_SECRET || 'zoeSecretKey_DevOnly_2026', 
    resave: false, saveUninitialized: true,
    cookie: { 
        secure: process.env.NODE_ENV === 'production', // עוגיות מאובטחות רק בפרודקשן
        maxAge: 24 * 60 * 60 * 1000 
    }
}));

app.use(express.static(path.join(__dirname, 'public')));

// הגדלת המגבלה משמעותית כיוון שכל הבקשות מגיעות מכתובות ה-IP של שרתי Twilio
const webhookLimiter = rateLimit({ 
    windowMs: 1 * 60 * 1000, 
    max: 3000, // מאפשר עד 3000 הודעות בדקה משרתי טוויליו
    message: '<Response><Message>System overloaded</Message></Response>',
    validate: { xForwardedForHeader: false } 
});

// --- פונקציית שליחת הודעת API אינטראקטיבית ---
async function sendWhatsAppMessage(to, body, listOptions = null) {
    if (!listOptions || listOptions.length === 0) {
        try {
            await client.messages.create({
                from: SYSTEM_WHATSAPP_NUMBER,
                to: to,
                body: body
            });
        } catch (err) {
            console.error('❌ Twilio Standard API Error:', err.message);
        }
        return;
    }

    let contentSid = null;
    try {
        const content = await client.content.v1.contents.create({
            friendlyName: `dynamic_list_${Date.now()}`,
            language: 'he',
            variables: {},
            types: {
                'twilio/list-picker': {
                    body: body,
                    button: 'בחר 🗓️',
                    items: listOptions.map((opt, i) => ({
                        id: opt, 
                        item: opt.replace(' ⭐', '').substring(0, 24), 
                        description: opt.includes('⭐') ? 'מומלץ (רציפות עבודה)' : ''
                    }))
                },
                'twilio/text': {
                    body: body + '\n' + listOptions.join('\n')
                }
            }
        });

        contentSid = content.sid;

        await client.messages.create({
            from: SYSTEM_WHATSAPP_NUMBER,
            to: to,
            contentSid: contentSid
        });

    } catch (err) {
        console.error('❌ Twilio Content API Error:', err.message);
        await client.messages.create({
            from: SYSTEM_WHATSAPP_NUMBER,
            to: to,
            body: body + '\n\n' + listOptions.map((opt, i) => `${i+1}. ${opt}`).join('\n')
        });
    } finally {
        if (contentSid) {
            try {
                await client.content.v1.contents(contentSid).remove();
            } catch (cleanupErr) {
                console.error('⚠️ Failed to clean up Content Template:', cleanupErr.message);
            }
        }
    }
}

// --- אימות מוקשח ---
function requireLogin(req, res, next) {
    if (req.session && req.session.user) next();
    else res.status(401).json({ error: 'Unauthorized', redirect: '/login.html' });
}

function getBizId(req) {
    if (!req.session || !req.session.user) return null; 

    if (req.session.user.permittedBusinessId === 'SUPER_ADMIN') {
        const requestedId = req.query.businessId || req.body.businessId;
        return requestedId === 'SUPER_ADMIN' ? null : requestedId; 
    }

    return req.session.user.permittedBusinessId;
}

function getRole(req) {
    if (!req.session || !req.session.user) return null;
    return req.session.user.permittedBusinessId === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'BUSINESS_ADMIN';
}

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        // 1. בדיקה אם מדובר במנהל-על (טבלת Admins)
        const adminRes = await db.pool.query("SELECT * FROM Admins WHERE Username = $1", [username]);
        if (adminRes.rows.length > 0) {
            const admin = adminRes.rows[0];
            const isMatch = await bcrypt.compare(password, admin.passwordhash);
            
            if (isMatch) {
                req.session.user = { id: admin.adminid, username: admin.username, permittedBusinessId: 'SUPER_ADMIN' };
                req.session.save(); 
                return res.json({ success: true, role: 'SUPER_ADMIN' });
            }
        }

        // 2. בדיקה אם מדובר בבעל עסק רגיל (טבלת Users)
        const userRes = await db.pool.query("SELECT * FROM Users WHERE Username = $1", [username]);
        if (userRes.rows.length > 0) {
            const user = userRes.rows[0];
            const isMatch = await bcrypt.compare(password, user.passwordhash);
            
            if (isMatch) {
                req.session.user = { id: user.userid, username: user.username, permittedBusinessId: user.businessid };
                req.session.save(); 
                return res.json({ success: true, role: 'BUSINESS' });
            }
        }

        // אם אף אחד לא התאים
        res.status(401).json({ success: false, message: 'שם משתמש או סיסמה שגויים' });

    } catch (e) { 
        console.error("API Error (/auth/login):", e.message);
        res.status(500).json({ error: 'Server error' }); 
    }
});

app.get('/api/auth/status', (req, res) => res.json({ loggedIn: !!(req.session && req.session.user), businessId: req.session && req.session.user ? req.session.user.permittedBusinessId : null }));
app.post('/api/auth/logout', (req, res) => { if(req.session) req.session.destroy(); res.json({ success: true }); });

// ==========================================
//          API ניהול (עם Try/Catch ולידציות)
// ==========================================

app.use('/api', requireLogin); 

app.get('/api/businesses', async (req, res) => {
    try {
        if (req.session.user && req.session.user.permittedBusinessId === 'SUPER_ADMIN') {
            const result = await db.pool.query('SELECT * FROM Businesses ORDER BY BusinessID');
            res.json(result.rows);
        } else {
            res.status(403).json({ error: 'Access denied' });
        }
    } catch (err) {
        console.error("API Error (/businesses GET):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/businesses', async (req, res) => {
    try {
        // נוודא שרק SUPER_ADMIN יכול ליצור עסקים (אבטחה)
        const role = getRole(req); 
        if (role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Unauthorized' });

        const { name, phone, ownerPhone, username, password } = req.body;
        if (!name || !phone || !username || !password) {
            return res.status(400).json({ error: "חסרים שדות חובה" });
        }

        // 1. הצפנת הסיסמה (Hashing)
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // פתיחת טרנזקציה כדי להבטיח שאם יצירת המשתמש נכשלת - העסק לא ייווצר בטעות
        await db.pool.query('BEGIN');

        // 2. יצירת העסק עצמו
        const bizRes = await db.pool.query(
            'INSERT INTO Businesses (BusinessName, WhatsAppNumber, OwnerPhone) VALUES ($1, $2, $3) RETURNING BusinessID',
            [name, phone, ownerPhone || '']
        );
        const newBizId = bizRes.rows[0].businessid;

        // 3. יצירת פרופיל עסק ריק כדי למנוע קריסות
        await db.pool.query('INSERT INTO Business_Profile (BusinessID) VALUES ($1)', [newBizId]);

        // 4. יצירת חשבון המשתמש של בעל העסק!
        await db.pool.query(
            'INSERT INTO Users (BusinessID, Username, PasswordHash, Role) VALUES ($1, $2, $3, $4)',
            [newBizId, username, passwordHash, 'BUSINESS_ADMIN']
        );

        await db.pool.query('COMMIT'); // שמירת כל השינויים
        res.json({ success: true, businessId: newBizId });

    } catch (err) {
        await db.pool.query('ROLLBACK'); // ביטול הפעולות במקרה של שגיאה (למשל אם שם המשתמש כבר קיים)
        console.error("API Error (/businesses POST):", err.message);
        res.status(500).json({ error: err.message.includes('unique constraint') ? 'שם המשתמש כבר קיים במערכת' : 'Internal Server Error' });
    }
});

app.get('/api/faq', async (req, res) => {
    try {
        const bizId = getBizId(req);
        if(!bizId) return res.json([]); 
        const result = await db.pool.query('SELECT * FROM FAQs WHERE BusinessID = $1 ORDER BY FAQID', [bizId]);
        res.json(result.rows);
    } catch (err) {
        console.error("API Error (/faq GET):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/faq', async (req, res) => {
    try {
        const { question, answer } = req.body;
        const bizId = getBizId(req);
        if (!bizId) return res.status(403).json({ error: 'Unauthorized' });
        if (!question || !answer || typeof question !== 'string' || typeof answer !== 'string') {
            return res.status(400).json({ error: "שאלה ותשובה חייבות להיות טקסט חוקי" });
        }
        await db.pool.query('INSERT INTO FAQs (BusinessID, Question, Answer) VALUES ($1, $2, $3)', [bizId, question, answer]);
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/faq POST):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.delete('/api/faq/:id', async (req, res) => {
    try {
        await db.pool.query('DELETE FROM FAQs WHERE FAQID=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/faq DELETE):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/api/services', async (req, res) => {
    try {
        const bizId = getBizId(req);
        if(!bizId) return res.json([]); 
        const result = await db.pool.query(`
            SELECT s.*, c.categoryname 
            FROM Services s 
            LEFT JOIN Service_Categories c ON s.categoryid = c.categoryid 
            WHERE s.BusinessID = $1 
            ORDER BY s.ServiceID
        `, [bizId]);
        res.json(result.rows);
    } catch (err) {
        console.error("API Error (/services GET):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/services', async (req, res) => {
    try {
        const { name, price, priceNote, durationData, windowStart, windowEnd, isSameDayOnly, requiresApproval, categoryId, basePrice, isDynamicPrice, depositAmount } = req.body;
        const bizId = getBizId(req);
        if (!bizId) return res.status(403).json({ error: 'Unauthorized' });
        
        if (!name || typeof name !== 'string') return res.status(400).json({ error: "שם טיפול חסר או לא תקין" });
        if (price === undefined || price < 0) return res.status(400).json({ error: "מחיר לא תקין" });
        
        await db.pool.query(`
            INSERT INTO Services 
            (BusinessID, ServiceName, Price, PriceNote, DurationData, WindowStart, WindowEnd, IsSameDayOnly, RequiresApproval, categoryid, base_price, is_dynamic_price, deposit_required_amount) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `, [
            bizId, name, price, priceNote || null, JSON.stringify(durationData || { duration: 30 }), windowStart, windowEnd, isSameDayOnly, requiresApproval, 
            categoryId || null, basePrice || price, isDynamicPrice || false, depositAmount || 0
        ]);
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/services POST):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.put('/api/services/:id', async (req, res) => {
    try {
        const { name, price, priceNote, durationData, windowStart, windowEnd, isSameDayOnly, requiresApproval, categoryId, basePrice, isDynamicPrice, depositAmount } = req.body;
        if (!name || typeof name !== 'string') return res.status(400).json({ error: "שם טיפול חסר או לא תקין" });
        if (price === undefined || price < 0) return res.status(400).json({ error: "מחיר לא תקין" });

        await db.pool.query(`
            UPDATE Services SET 
            ServiceName=$1, Price=$2, PriceNote=$3, DurationData=$4, WindowStart=$5, WindowEnd=$6, IsSameDayOnly=$7, RequiresApproval=$8, 
            categoryid=$9, base_price=$10, is_dynamic_price=$11, deposit_required_amount=$12 
            WHERE ServiceID=$13
        `, [
            name, price, priceNote || null, JSON.stringify(durationData || { duration: 30 }), windowStart, windowEnd, isSameDayOnly, requiresApproval, 
            categoryId || null, basePrice || price, isDynamicPrice || false, depositAmount || 0, req.params.id
        ]);
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/services PUT):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.delete('/api/services/:id', async (req, res) => {
    try {
        await db.pool.query('DELETE FROM Services WHERE ServiceID=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/services DELETE):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- נתיבי API עבור מוצרים (E-commerce) ---

app.get('/api/products', async (req, res) => {
    try {
        const bizId = getBizId(req);
        if(!bizId) return res.json([]); 
        const result = await db.pool.query('SELECT * FROM Products WHERE BusinessID = $1 ORDER BY ProductID DESC', [bizId]);
        res.json(result.rows);
    } catch (err) {
        console.error("API Error (/products GET):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/products', async (req, res) => {
    try {
        const bizId = getBizId(req);
        if (!bizId) return res.status(403).json({ error: 'Unauthorized' });
        
        const { name, price, stock, alertThreshold, requiresApproval } = req.body;
        if (!name || !price) return res.status(400).json({ error: "שם מוצר ומחיר הם חובה" });
        
        await db.pool.query(`
            INSERT INTO Products (BusinessID, ProductName, Price, StockQuantity, AlertThreshold, RequiresApproval) 
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [bizId, name, price, stock || 0, alertThreshold || 5, requiresApproval || false]);
        
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/products POST):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.delete('/api/products/:id', async (req, res) => {
    try {
        await db.pool.query('DELETE FROM Products WHERE ProductID=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/products DELETE):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/api/categories', async (req, res) => {
    try {
        const bizId = getBizId(req);
        if(!bizId) return res.json([]); 
        const result = await db.pool.query('SELECT * FROM Service_Categories WHERE BusinessID = $1 ORDER BY CategoryID', [bizId]);
        res.json(result.rows);
    } catch (err) {
        console.error("API Error (/categories GET):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- API לניהול צוות עובדים (Staff) ---

app.get('/api/staff', async (req, res) => {
    try {
        const bizId = getBizId(req);
        if(!bizId) return res.json([]);
        
        // שליפת כל העובדים
        const staffRes = await db.pool.query('SELECT * FROM Staff WHERE BusinessID = $1 ORDER BY StaffID', [bizId]);
        const staff = staffRes.rows;
        
        // שליפת הטיפולים שמשויכים לכל עובד
        const relationsRes = await db.pool.query(`
            SELECT ss.StaffID, ss.ServiceID 
            FROM Service_Staff ss 
            JOIN Staff s ON ss.StaffID = s.StaffID 
            WHERE s.BusinessID = $1
        `, [bizId]);
        
        // בניית מערך שירותים לכל עובד
        staff.forEach(emp => {
            emp.services = relationsRes.rows
                .filter(r => r.staffid === emp.staffid)
                .map(r => r.serviceid);
        });
        
        res.json(staff);
    } catch (err) {
        console.error("API Error (/staff GET):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/staff', async (req, res) => {
    try {
        const bizId = getBizId(req);
        const { staffId, name, phone, calendarId, isActive, serviceIds } = req.body;
        
        let currentStaffId = staffId;
        
        if (staffId) {
            // עדכון עובד קיים
            await db.pool.query(
                'UPDATE Staff SET StaffName=$1, Phone=$2, GoogleCalendarID=$3, IsActive=$4 WHERE StaffID=$5 AND BusinessID=$6',
                [name, phone, calendarId, isActive, staffId, bizId]
            );
        } else {
            // יצירת עובד חדש
            const insertRes = await db.pool.query(
                'INSERT INTO Staff (BusinessID, StaffName, Phone, GoogleCalendarID, IsActive) VALUES ($1, $2, $3, $4, $5) RETURNING StaffID',
                [bizId, name, phone, calendarId, isActive !== false]
            );
            currentStaffId = insertRes.rows[0].staffid;
        }
        
        // עדכון טבלת הגישור (מוחקים הכל ומכניסים מחדש - הכי בטוח)
        await db.pool.query('DELETE FROM Service_Staff WHERE StaffID = $1', [currentStaffId]);
        
        if (serviceIds && serviceIds.length > 0) {
            for (let sId of serviceIds) {
                await db.pool.query('INSERT INTO Service_Staff (ServiceID, StaffID) VALUES ($1, $2)', [sId, currentStaffId]);
            }
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/staff POST/PUT):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.delete('/api/staff/:id', async (req, res) => {
    try {
        await db.pool.query('DELETE FROM Staff WHERE StaffID=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- API כרטיסיות מועדון (Loyalty) ---
app.get('/api/loyalty', async (req, res) => {
    try {
        const bizId = getBizId(req);
        if(!bizId) return res.json([]);
        // שולפים רק כרטיסיות פעילות או כאלו שהושלמו (לא ארכיון)
        const result = await db.pool.query(
            `SELECT lc.*, s.ServiceName 
             FROM ClientCards lc 
             LEFT JOIN Services s ON lc.ServiceID = s.ServiceID 
             WHERE lc.BusinessID = $1 AND lc.Status != 'Archived'
             ORDER BY lc.Status ASC, lc.CreatedAt DESC`, 
            [bizId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("API Error (/loyalty GET):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/loyalty', async (req, res) => {
    try {
        const bizId = getBizId(req);
        const { customerPhone, serviceId, totalPunches, paymentMode, notes } = req.body;
        
        if (!customerPhone || !serviceId || totalPunches <= 0) {
            return res.status(400).json({ error: "נתונים חסרים או לא תקינים" });
        }
        
        // שים לב: הסרנו את ServiceName כי הוא נשלף אוטומטית מה-JOIN
        await db.pool.query(
            `INSERT INTO ClientCards (BusinessID, CustomerPhone, ServiceID, TotalPunches, UsedPunches, PaymentMode, Notes, Status) 
             VALUES ($1, $2, $3, $4, 0, $5, $6, 'Active')`, 
            [bizId, customerPhone, serviceId, totalPunches, paymentMode || 'Manual_Payment', notes || '']
        );
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/loyalty POST):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.put('/api/loyalty/:id/punch', async (req, res) => {
    try {
        // מעדכנים ניקוב, ואם הגענו למקסימום - מעדכנים סטטוס ל-Completed
        await db.pool.query(`
            UPDATE ClientCards 
            SET UsedPunches = UsedPunches + 1,
                Status = CASE WHEN UsedPunches + 1 >= TotalPunches THEN 'Completed' ELSE Status END
            WHERE CardID = $1 AND UsedPunches < TotalPunches
        `, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/loyalty punch):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.put('/api/loyalty/:id/archive', async (req, res) => {
    try {
        // העברה לארכיון (מסתיר את הכרטיסייה מהתצוגה הראשית)
        await db.pool.query("UPDATE ClientCards SET Status = 'Archived' WHERE CardID = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/loyalty archive):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/broadcast', async (req, res) => {
    try {
        const { audience, message } = req.body;
        const bizId = getBizId(req);
        if (!message) return res.status(400).json({ error: "הודעה חסרה" });
        
        let query = "SELECT CustomerPhone FROM Customers WHERE BusinessID = $1 AND MarketingConsent = true";
        const queryParams = [bizId];
        
        if (audience === 'VIP') {
            query += " AND Status = $2";
            queryParams.push('VIP');
        } else if (audience === 'Inactive') {
            query += " AND LastInteraction < NOW() - INTERVAL '60 days'";
        }
        
        const targets = await db.pool.query(query, queryParams);
        
        // שליפת מספר הטלפון הייעודי של העסק השולח
        const bizRes = await db.pool.query('SELECT WhatsAppNumber FROM Businesses WHERE BusinessID = $1', [bizId]);
        const fromNumber = bizRes.rows.length > 0 ? bizRes.rows[0].whatsappnumber : SYSTEM_WHATSAPP_NUMBER;

        let count = 0;
        for (const cust of targets.rows) {
            await new Promise(r => setTimeout(r, 250)); // Rate limit
            client.messages.create({ 
                from: fromNumber, 
                to: cust.customerphone, 
                body: message 
            }).catch(e => console.error('Failed to send WhatsApp message:', e.message));
            count++;
        }
        await db.pool.query("INSERT INTO Broadcasts (BusinessID, TargetAudience, MessageText, RecipientsCount) VALUES ($1, $2, $3, $4)", [bizId, audience, message, count]);
        res.json({ success: true, count });
    } catch (err) {
        console.error("API Error (/broadcast POST):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- API לניהול אוטומציות CRM ---

app.get('/api/automations', async (req, res) => {
    try {
        const bizId = getBizId(req);
        if(!bizId) return res.json([]);
        const result = await db.pool.query('SELECT * FROM Automated_Messages WHERE BusinessID = $1 ORDER BY TriggerType, OffsetMinutes', [bizId]);
        res.json(result.rows);
    } catch (err) {
        console.error("API Error (/automations GET):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/automations', async (req, res) => {
    try {
        const bizId = getBizId(req);
        const { serviceId, triggerType, offsetMinutes, template } = req.body;
        
        await db.pool.query(`
            INSERT INTO Automated_Messages (BusinessID, ServiceID, TriggerType, OffsetMinutes, MessageTemplate) 
            VALUES ($1, $2, $3, $4, $5)
        `, [bizId, serviceId || null, triggerType, offsetMinutes, template]);
        
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/automations POST):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.delete('/api/automations/:id', async (req, res) => {
    try {
        await db.pool.query('DELETE FROM Automated_Messages WHERE MessageID=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const bizId = getBizId(req);
        if(!bizId) return res.json({stats:{}, pendingAppointments:[], lowStockProducts:[]});

        const today = new Date().toISOString().split('T')[0];
        
        // שליפת תורים ממתינים
        const pendingAppts = await db.pool.query(
            `SELECT a.AppointmentID, a.CustomerName, a.StartTime, a.CustomerPhone, s.ServiceName 
             FROM Appointments_Log a 
             LEFT JOIN Services s ON a.ServiceID = s.ServiceID 
             WHERE a.BusinessID = $1 AND a.Status = 'Pending' 
             ORDER BY a.StartTime ASC`, 
            [bizId]
        );
        
        // שליפת סטטיסטיקות (כולל חישוב הכנסה יומית צפויה מהתורים של היום)
        const stats = await db.pool.query(
            `SELECT 
                (SELECT COUNT(*) FROM Appointments_Log WHERE BusinessID=$1 AND DATE(StartTime)=$2 AND Status='Confirmed') as todayCount, 
                (SELECT COUNT(*) FROM Appointments_Log WHERE BusinessID=$1 AND Status='Pending') as pendingCount,
                (SELECT COALESCE(SUM(s.Price), 0) FROM Appointments_Log a JOIN Services s ON a.ServiceID = s.ServiceID WHERE a.BusinessID=$1 AND DATE(a.StartTime)=$2 AND a.Status='Confirmed') as expectedRevenue
            `, 
            [bizId, today]
        );

        // שליפת מוצרים בחוסר (כמות נוכחית קטנה או שווה לסף ההתראה)
        const lowStock = await db.pool.query(
            `SELECT ProductID, ProductName, StockQuantity, AlertThreshold 
             FROM Products 
             WHERE BusinessID = $1 AND IsActive = TRUE AND StockQuantity <= AlertThreshold 
             ORDER BY StockQuantity ASC`,
            [bizId]
        );

        res.json({ 
            stats: stats.rows[0], 
            pendingAppointments: pendingAppts.rows,
            lowStockProducts: lowStock.rows
        });
    } catch (err) {
        console.error("API Error (/dashboard/stats GET):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/appointments/:id/approve', async (req, res) => {
    try {
        const result = await db.pool.query("UPDATE Appointments_Log SET Status='Confirmed' WHERE AppointmentID=$1 RETURNING *", [req.params.id]);
        const appt = result.rows[0];
        if(appt) client.messages.create({ 
            from: SYSTEM_WHATSAPP_NUMBER, 
            to: appt.customerphone, 
            body: `היי ${appt.customername}, התור שלך אושר! ✅` 
        }).catch(e => console.error('Failed to send WhatsApp message:', e.message));
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/appointments approve):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/appointments/:id/reject', async (req, res) => {
    try {
        const oldAppt = await db.pool.query("SELECT * FROM Appointments_Log WHERE AppointmentID=$1", [req.params.id]);
        if(oldAppt.rows.length > 0) {
            const appt = oldAppt.rows[0];
            const profile = await db.pool.query("SELECT GoogleCalendarID FROM Business_Profile WHERE BusinessID=$1", [appt.businessid]);
            if (profile.rows.length > 0 && appt.googlecalendareventid) await scheduler.cancelAppointment(profile.rows[0].googlecalendarid, appt.googlecalendareventid);
            await db.pool.query("UPDATE Appointments_Log SET Status='Cancelled' WHERE AppointmentID=$1", [req.params.id]);
            client.messages.create({ 
                from: SYSTEM_WHATSAPP_NUMBER, 
                to: appt.customerphone, 
                body: `היי ${appt.customername}, לצערנו התור לא אושר ובוטל.` 
            }).catch(e => console.error('Failed to send WhatsApp message:', e.message));
        }
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/appointments reject):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- API לניהול הודעות ולקוחות (Inbox & CRM) ---

app.get('/api/customers', async (req, res) => {
    try {
        const bizId = getBizId(req);
        if(!bizId) return res.json([]);
        const result = await db.pool.query('SELECT * FROM Customers WHERE BusinessID = $1 ORDER BY CreatedAt DESC LIMIT 200', [bizId]);
        res.json(result.rows);
    } catch (err) {
        console.error("API Error (/customers GET):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// הוספת לקוח ידנית
app.post('/api/customers', async (req, res) => {
    try {
        const bizId = getBizId(req);
        const { name, phone, gender, status } = req.body;
        if (!name || !phone) return res.status(400).json({ error: "שם וטלפון הם חובה" });

        await db.pool.query(
            `INSERT INTO Customers (BusinessID, CustomerName, CustomerPhone, Gender, Status, CreatedAt) 
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (BusinessID, CustomerPhone) DO NOTHING`,
            [bizId, name, phone, gender || 'neutral', status || 'Regular']
        );
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/customers POST):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.put('/api/customers/:id', async (req, res) => {
    try {
        const { name, gender, status, marketingConsent } = req.body; 
        await db.pool.query('UPDATE Customers SET CustomerName=$1, Gender=$2, Status=$3, MarketingConsent=$4 WHERE CustomerID=$5', [name, gender, status, marketingConsent, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/customers PUT):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/api/messages', async (req, res) => {
    try {
        const bizId = getBizId(req);
        if(!bizId) return res.json([]);
        const result = await db.pool.query('SELECT * FROM Messages WHERE BusinessID = $1 ORDER BY CreatedAt DESC LIMIT 50', [bizId]);
        res.json(result.rows);
    } catch (err) {
        console.error("API Error (/messages GET):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// עדכון סטטוס הודעה (טופל/לא טופל)
app.put('/api/messages/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        await db.pool.query('UPDATE Messages SET Status = $1 WHERE MessageID = $2', [status, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/messages status PUT):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// מחיקת הודעה
app.delete('/api/messages/:id', async (req, res) => {
    try {
        await db.pool.query('DELETE FROM Messages WHERE MessageID = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/messages DELETE):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/api/businesses/:id', async (req, res) => {
    try {
        const biz = await db.pool.query('SELECT * FROM Businesses WHERE BusinessID=$1', [req.params.id]);
        const prof = await db.pool.query('SELECT * FROM Business_Profile WHERE BusinessID=$1', [req.params.id]);
        res.json({ business: biz.rows[0], profile: prof.rows[0] });
    } catch (err) {
        console.error("API Error (/businesses/:id GET):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.put('/api/profile/:id', async (req, res) => {
    try {
        const { calendarId, blockedCalendars, templates, operatingHours, facebookUrl, instagramUrl, address, ownerName } = req.body;
        
        if (templates) {
            await db.pool.query(
                `UPDATE Business_Profile SET Templates = COALESCE(Templates, '{}'::jsonb) || $1 WHERE BusinessID=$2`, 
                [JSON.stringify(templates), req.params.id]
            );
        } 
        
        // עדכון טבלת הפרופיל (כולל הכתובת החדשה)
        if (operatingHours || calendarId !== undefined || facebookUrl !== undefined || instagramUrl !== undefined || address !== undefined) {
            await db.pool.query(
                `UPDATE Business_Profile SET 
                    GoogleCalendarID = COALESCE($1, GoogleCalendarID), 
                    blocked_calendars = COALESCE($2, blocked_calendars), 
                    OperatingHours = COALESCE($3, OperatingHours),
                    facebook_url = COALESCE($5, facebook_url),
                    instagram_url = COALESCE($6, instagram_url),
                    address = COALESCE($7, address)
                 WHERE BusinessID=$4`, 
                [
                    calendarId, 
                    blockedCalendars, 
                    operatingHours ? JSON.stringify(operatingHours) : null, 
                    req.params.id, 
                    facebookUrl !== undefined ? facebookUrl : null, 
                    instagramUrl !== undefined ? instagramUrl : null,
                    address !== undefined ? address : null
                ]
            );
        }

        // עדכון טבלת העסקים (עבור שם בעל העסק)
        if (ownerName !== undefined) {
            await db.pool.query(
                `UPDATE Businesses SET OwnerName = $1 WHERE BusinessID = $2`,
                [ownerName, req.params.id]
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error("API Error (/profile PUT):", err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ראוט ציבורי לאימות עסק מול מטא
app.get('/verify/:businessId', async (req, res) => {
    const { businessId } = req.params;

    try {
        const result = await db.pool.query(
            `SELECT b.businessname, b.ownerphone, b.owneremail, bp.address, bp.facebook_url, bp.instagram_url 
             FROM businesses b
             LEFT JOIN business_profile bp ON b.businessid = bp.businessid
             WHERE b.businessid = $1`,
            [businessId]
        );

        if (result.rows.length === 0) {
            return res.status(404).send('עסק לא נמצא / Business not found');
        }

        const biz = result.rows[0];

        let extraLinksHtml = '';
        if (biz.owneremail) {
            extraLinksHtml += `<div class="detail"><strong>אימייל:</strong> <span><a href="mailto:${biz.owneremail}" style="color:#0056b3; text-decoration:none;">${biz.owneremail}</a></span></div>`;
        }
        if (biz.facebook_url) {
            extraLinksHtml += `<div class="detail"><strong>פייסבוק:</strong> <span><a href="${biz.facebook_url}" target="_blank" style="color:#0056b3;">עמוד הפייסבוק הרשמי</a></span></div>`;
        }
        if (biz.instagram_url) {
            extraLinksHtml += `<div class="detail"><strong>אינסטגרם:</strong> <span><a href="${biz.instagram_url}" target="_blank" style="color:#0056b3;">פרופיל האינסטגרם הרשמי</a></span></div>`;
        }

        const htmlContent = `
        <!DOCTYPE html>
        <html lang="he" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${biz.businessname} - כרטיס ביקור רשמי</title>
            <style>
                body { font-family: 'Arial', sans-serif; background-color: #f4f7f6; color: #333; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .card { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); text-align: center; max-width: 400px; width: 100%; border-top: 4px solid #0056b3; }
                h1 { margin-top: 0; color: #222; font-size: 24px; }
                .detail { margin: 15px 0; font-size: 16px; display: flex; align-items: center; justify-content: center; gap: 10px; }
                .footer { margin-top: 30px; font-size: 12px; color: #777; border-top: 1px solid #eee; padding-top: 15px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>${biz.businessname}</h1>
                <div class="detail"><strong>כתובת:</strong> <span>${biz.address || 'כתובת לא הוזנה'}</span></div>
                <div class="detail"><strong>טלפון:</strong> <span><a href="tel:${biz.ownerphone}" style="text-decoration:none; color:#0056b3;">${biz.ownerphone || 'לא הוזן מספר'}</a></span></div>
                ${extraLinksHtml}
                <div class="footer">עמוד קשר ואימות עסקי רשמי.<br>מופעל טכנולוגית על ידי פלטפורמת ZOE.</div>
            </div>
        </body>
        </html>`;

        res.send(htmlContent);
    } catch (err) {
        console.error('Error generating verification page:', err);
        res.status(500).send('Internal Server Error');
    }
});

// ==========================================
//          BOT WEBHOOK
// ==========================================

const SESSION_TIMEOUT_MINUTES = 15; 

async function getSession(phone, bizId) {
    const result = await db.pool.query(
        'SELECT current_state, temp_data, last_updated FROM bot_sessions WHERE phone_number = $1 AND businessid = $2',
        [phone, bizId]
    );
    
    if (result.rows.length > 0) {
        const session = result.rows[0];
        
        const lastUpdated = new Date(session.last_updated);
        const now = new Date();
        const diffMinutes = (now - lastUpdated) / 1000 / 60;
        
        if (diffMinutes > SESSION_TIMEOUT_MINUTES) {
            console.log(`[Session] Timeout for ${phone}. Clearing memory...`);
            await clearSession(phone, bizId);
            return { current_state: 'START', temp_data: {} };
        }
        return session;
    }
    return { current_state: 'START', temp_data: {} };
}

async function updateSession(phone, bizId, state, data = {}) {
    if (!bizId) return; 
    await db.pool.query(
        `INSERT INTO bot_sessions (businessid, phone_number, current_state, temp_data, last_updated)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (businessid, phone_number) 
         DO UPDATE SET current_state = EXCLUDED.current_state, 
                       temp_data = EXCLUDED.temp_data, 
                       last_updated = CURRENT_TIMESTAMP`,
        [bizId, phone, state, JSON.stringify(data)]
    );
}

async function clearSession(phone, bizId) {
    await db.pool.query(
        'DELETE FROM bot_sessions WHERE phone_number = $1 AND businessid = $2',
        [phone, bizId]
    );
}

function t(textKey, gender, templates) {
    let text = templates[textKey] || textKey;
    const defaults = {
        'welcome_new': 'היי! ברוך הבא ל*{businessName}*. איך קוראים לך?',
        'welcome_returning': 'היי {name}! כיף שחזרת ל*{businessName}*.',
        'menu_text': 'איך אפשר לעזור?',
        'choose_service': 'בחר טיפול מהרשימה:',
        'choose_date': 'באיזה תאריך תרצה להגיע? (כתוב תאריך, למשל 28.10)',
        'marketing_ask': 'האם תרצה לקבל מאיתנו עדכונים ומבצעים שווים? (נשלח רק דברים חשובים!)',
        'marketing_thank_yes': 'מעולה! רשמתי לפניי. 🎁',
        'marketing_thank_no': 'אין בעיה, מכבדים את הפרטיות שלך. 👌'
    };
    if (!templates[textKey]) text = defaults[textKey] || textKey;
    
    if (gender === 'Male') text = text.replace('ברוכה הבאה', 'ברוך הבא').replace('יקירה', 'יקר').replace('תרצי', 'תרצה').replace('תרצי', 'תרצה');
    else if (gender === 'Female') text = text.replace('ברוך הבא', 'ברוכה הבאה').replace('יקר', 'יקירה').replace('תרצה', 'תרצי');
    else text = text.replace('ברוך הבא', 'שלום').replace('יקר', '').replace('מתי תרצה להגיע', 'באיזו שעה לקבוע');
    return text;
}

// פונקציה לייצור תפריט קטגוריות
function generateCategoryMenu(categories) {
    const menuText = 'באיזו קטגוריה מדובר? 📁\n(לחץ על הכפתור למטה לבחירה)';
    const options = categories.map(c => c.substring(0, 24)); 
    return { text: menuText, options: options };
}

// פונקציה לייצור תפריט טיפולים (עם פאגינציה חכמה 1+8+1)
function generateFilteredServiceMenu(state) {
    const services = state.data.filteredServices || [];
    let page = state.data.servicePage || 0;
    let menuText = `טיפולים בקטגוריית ${state.data.selectedCategory} ✂️\n(לחץ על הכפתור למטה לבחירה):`;
    let options = [];

    const formatService = (s) => {
        const note = s.pricenote ? ` (${s.pricenote})` : '';
        return `${s.servicename} (₪${s.price}${note})`.substring(0, 24);
    };

    if (services.length <= 10) {
        options = services.map(s => formatService(s));
        return { text: menuText, options: options };
    }

    if (page === 0) {
        options = services.slice(0, 9).map(s => formatService(s));
        options.push('🔽 הצג טיפולים נוספים');
    } else {
        options.push('🔼 חזור אחורה');
        const startIndex = 9 + (page - 1) * 8;
        options.push(...services.slice(startIndex, startIndex + 8).map(s => formatService(s)));
        if (startIndex + 8 < services.length) options.push('🔽 הצג טיפולים נוספים');
    }
    
    return { text: menuText, options: options };
}

// פונקציה לייצור תפריט מוצרים (עם פאגינציה)
function generateProductMenu(state) {
    const products = state.data.products || [];
    let page = state.data.productPage || 0;
    let menuText = 'בחר מוצר להוספה לעגלה 🛍️\n(לחץ על הכפתור למטה לבחירה):';
    let options = [];

    const formatProduct = (p) => `${p.productname} (₪${p.price})`.substring(0, 24);

    if (products.length <= 10) {
        options = products.map(p => formatProduct(p));
        return { text: menuText, options: options };
    }

    if (page === 0) {
        options = products.slice(0, 9).map(p => formatProduct(p));
        options.push('🔽 מוצרים נוספים');
    } else {
        options.push('🔼 חזור אחורה');
        const startIndex = 9 + (page - 1) * 8;
        options.push(...products.slice(startIndex, startIndex + 8).map(p => formatProduct(p)));
        if (startIndex + 8 < products.length) options.push('🔽 מוצרים נוספים');
    }
    
    return { text: menuText, options: options };
}

// מנוע פאגינציה מעודכן לרשימות אינטראקטיביות של שעות
function generateInteractiveMenuData(state) {
    const allSlots = state.data.allSlots || [];
    let page = state.data.page || 0;
    let menuText = `תורים פנויים ל-${state.data.selectedDate}:\n(לחץ על הכפתור למטה לבחירה, או הקלד שעה ידנית להמתנה)`;
    let options = [];

    if (allSlots.length <= 10) {
        options = allSlots.slice(0, 10);
        return { text: menuText, options: options };
    }

    if (page === 0) {
        options = allSlots.slice(0, 9);
        options.push('🔽 הצג שעות מאוחרות יותר');
    } else {
        menuText = `שעות נוספות ל-${state.data.selectedDate}:`;
        options.push('🔼 חזור לשעות הקודמות');
        
        const startIndex = 9 + (page - 1) * 8;
        const slotsToDisplay = allSlots.slice(startIndex, startIndex + 8);
        options.push(...slotsToDisplay);

        if (startIndex + 8 < allSlots.length) {
            options.push('🔽 הצג שעות מאוחרות יותר');
        } else {
            options.push('📅 חפש בתאריך חדש');
        }
    }
    
    return { text: menuText, options: options };
}

// פונקציית הכנת תפריט שאלות נפוצות
async function generateFAQMenu(businessid) {
    const faqRes = await db.pool.query('SELECT question FROM FAQs WHERE BusinessID = $1 LIMIT 10', [businessid]);
    const faqs = faqRes.rows;

    if (faqs.length === 0) return null;

    const menuText = 'במה נוכל לעזור? ❓\nבחר שאלה מהרשימה למטה:';
    const options = faqs.map(f => f.question.substring(0, 24)); 

    return { text: menuText, options: options };
}

// פונקציית נתב: מדלגת על בחירת צוות אם יש רק עובד אחד מתאים
async function routeToStaffOrDate(state, fromNumber, businessid, res, sendWhatsAppMessage, updateSession, db) {
    const cartServiceIds = state.data.cart.map(s => s.serviceid || s.ServiceID);
    
    const staffRes = await db.pool.query(`
        SELECT s.StaffID, s.StaffName, s.GoogleCalendarID
        FROM Staff s
        JOIN Service_Staff ss ON s.StaffID = ss.StaffID
        WHERE s.BusinessID = $1 AND s.IsActive = TRUE AND ss.ServiceID = ANY($2::int[])
        GROUP BY s.StaffID, s.StaffName, s.GoogleCalendarID
        HAVING COUNT(DISTINCT ss.ServiceID) = $3
    `, [businessid, cartServiceIds, cartServiceIds.length]);

    const staffList = staffRes.rows;

    if (staffList.length === 0) {
        await sendWhatsAppMessage(fromNumber, 'מצטערים, אין כרגע איש צוות שמוסמך לבצע את כל הטיפולים יחד. 😕\nאנא נקה את העגלה וקבע כל טיפול בנפרד, או לחץ 0 לנציג.');
        return res.status(200).send('<Response></Response>');
    }

    if (staffList.length === 1) {
        state.data.selectedStaff = staffList[0];
        state.step = 'SELECT_DATE';
        await updateSession(fromNumber, businessid, state.step, state.data);
        
        const d = new Date();
        const exampleDate = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}`;
        await sendWhatsAppMessage(fromNumber, `מעולה! הטיפול יבוצע ע"י *${staffList[0].staffname}* ב-${state.data.selectedLocation.locationname}.\nלבחירת תאריך הקלד/י בפורמט חודש.יום (לדוגמה: ${exampleDate}), או רשום/י 'מחר' או 'רביעי'. 🗓️\n\n(הקש 0 לתפריט הראשי)`);
    } else {
        state.data.staffList = staffList;
        state.step = 'SELECT_STAFF';
        await updateSession(fromNumber, businessid, state.step, state.data);
        
        const staffOptions = staffList.map(s => s.staffname).slice(0, 10);
        await sendWhatsAppMessage(fromNumber, 'אצל מי תרצה לקבוע את הטיפול? 🧑‍⚕️\n(לחץ על התפריט לבחירה)\n\n(הקש 0 לתפריט הראשי)', staffOptions);
    }
    return res.status(200).send('<Response></Response>');
}

app.post('/webhook', webhookLimiter, async (req, res) => {
    let incomingMsg = req.body.Body ? req.body.Body.trim() : '';
    const fromNumber = req.body.From; 
    const toNumber = req.body.To;
    let replyText = '';
    let businessid_for_catch = null; 
  
    try {
        const businessRes = await db.pool.query('SELECT * FROM Businesses WHERE WhatsAppNumber = $1', [toNumber]);
        let business = businessRes.rows[0];
        if (!business && toNumber === 'whatsapp:+14155238886') { 
            const def = await db.pool.query('SELECT * FROM Businesses LIMIT 1');
            business = def.rows[0];
        }
        if (!business) { 
            await sendWhatsAppMessage(fromNumber, 'עסק לא מוגדר.'); 
            return res.status(200).send('<Response></Response>'); 
        }
  
        const { businessid, businessname, ownerphone } = business;
        businessid_for_catch = businessid; 
        const profileRes = await db.pool.query('SELECT * FROM Business_Profile WHERE BusinessID = $1', [businessid]);
        const profile = profileRes.rows[0] || {};
        const templates = profile.templates || {};
  
        let customer = null;
        const custRes = await db.pool.query('SELECT * FROM Customers WHERE BusinessID=$1 AND CustomerPhone=$2', [businessid, fromNumber]);
        if(custRes.rows.length > 0) customer = custRes.rows[0];
        if (customer && customer.status === 'Block') return res.status(200).end();
  
        const dbSession = await getSession(fromNumber, businessid);
        let state = {
            step: dbSession.current_state,
            data: dbSession.temp_data || {}
        };
        const gender = customer ? (customer.gender || 'neutral') : 'neutral';

        // ==========================================
        // 🛡️ מיירטים גלובליים (Global Interceptors)
        // ==========================================

        if (incomingMsg === '0' || incomingMsg === 'תפריט' || incomingMsg === 'ראשי') {
            state.step = 'IDLE';
            // אנחנו מוחקים הכל חוץ מהעגלה!
            const currentCart = state.data.cart || [];
            state.data = { cart: currentCart }; 
            await updateSession(fromNumber, businessid, state.step, state.data);
        } 
        else if (incomingMsg.includes('נציג') || incomingMsg.includes('אנושי')) {
            state.step = 'WAITING_FOR_AGENT';
            await updateSession(fromNumber, businessid, state.step, state.data);
            await sendWhatsAppMessage(fromNumber, 'העברתי את הפנייה שלך. נציג אנושי יחזור אליך בהקדם! 🧑‍💻');
            return res.status(200).send('<Response></Response>');
        }

        const dateAttempt = parseDate(incomingMsg);
        const allowedDateStates = ['CART_DECISION', 'SELECT_TIME', 'CONFIRM_WAITLIST', 'SELECT_STAFF'];
        
        if (dateAttempt && allowedDateStates.includes(state.step)) {
            state.step = 'SELECT_DATE';
            incomingMsg = dateAttempt; 
        }

        // ==========================================
        // 📱 מנוע הסטטוסים (State Machine)
        // ==========================================

        if (state.step === 'IDLE') {
            const custName = customer ? customer.customername : 'לקוח יקר';
            const bizName = profile.businessname || businessname;
            const greeting = `היי ${custName}! ברוך הבא ל*${bizName}*.\nאיך אפשר לעזור היום?\n\n💡 _ניתן להקיש 0 לחזרה לתפריט בכל שלב_`;
            
            // בדיקה האם העסק מוכר מוצרים
            const prodCountRes = await db.pool.query('SELECT COUNT(*) FROM Products WHERE BusinessID=$1 AND IsActive=TRUE', [businessid]);
            const hasProducts = parseInt(prodCountRes.rows[0].count) > 0;

            const mainOptions = [
                '📅 קביעת תור חדש',
                ...(hasProducts ? ['🛍️ חנות מוצרים'] : []), // הכפתור יופיע רק אם יש מוצרים
                '✏️ התורים שלי',
                '🕒 שעות פעילות',
                '❓ שאלות נפוצות',
                '✉️ הגדרות דיוור',
                '🙋‍♂️ דבר עם נציג'
            ];
            
            state.step = 'MAIN_MENU_CHOICE';
            await updateSession(fromNumber, businessid, state.step, state.data);
            
            await sendWhatsAppMessage(fromNumber, greeting, mainOptions);
            return res.status(200).send('<Response></Response>');
        }
        
        else if (state.step === 'MAIN_MENU_CHOICE') {
            if (incomingMsg.includes('קביעת תור')) {
                const catRes = await db.pool.query(`
                    SELECT DISTINCT COALESCE(c.CategoryName, 'כללי') as categoryname 
                    FROM Services s 
                    LEFT JOIN Service_Categories c ON s.categoryid = c.categoryid 
                    WHERE s.BusinessID=$1
                `, [businessid]);
                const categories = catRes.rows.map(r => r.categoryname);
                
                if (categories.length === 0) {
                    await sendWhatsAppMessage(fromNumber, 'אין טיפולים זמינים כרגע במערכת.\n\n(הקש 0 לתפריט הראשי)');
                    return res.status(200).send('<Response></Response>');
                }

                if (categories.length === 1) {
                    const category = categories[0];
                    const servicesRes = await db.pool.query(`
                        SELECT s.*, COALESCE(c.CategoryName, 'כללי') as categoryname 
                        FROM Services s 
                        LEFT JOIN Service_Categories c ON s.categoryid = c.categoryid 
                        WHERE s.BusinessID=$1 AND COALESCE(c.CategoryName, 'כללי')=$2
                    `, [businessid, category]);
                    
                    state.data.selectedCategory = category;
                    state.data.filteredServices = servicesRes.rows;
                    state.data.servicePage = 0;
                    state.step = 'SELECT_SERVICE';
                    
                    const menuData = generateFilteredServiceMenu(state);
                    await updateSession(fromNumber, businessid, state.step, state.data);
                    await sendWhatsAppMessage(fromNumber, `בחרת בקטגוריית ${category}.\n` + menuData.text, menuData.options);
                } 
                else {
                    state.data.categories = categories;
                    state.step = 'SELECT_CATEGORY';
                    const menuData = generateCategoryMenu(categories);
                    await updateSession(fromNumber, businessid, state.step, state.data);
                    await sendWhatsAppMessage(fromNumber, menuData.text, menuData.options);
                }
                return res.status(200).send('<Response></Response>');
            } 
            
            else if (incomingMsg.includes('חנות')) {
                // שולפים רק מוצרים פעילים שיש מהם במלאי
                const prodRes = await db.pool.query('SELECT * FROM Products WHERE BusinessID=$1 AND IsActive=TRUE AND StockQuantity > 0', [businessid]);
                const products = prodRes.rows;

                if (products.length === 0) {
                    await sendWhatsAppMessage(fromNumber, 'החנות שלנו כרגע מתעדכנת במוצרים חדשים. חזור בקרוב! 📦\n\n(הקש 0 לחזרה)');
                    return res.status(200).send('<Response></Response>');
                }

                state.data.products = products;
                state.data.productPage = 0;
                state.step = 'SELECT_PRODUCT';
                
                const menuData = generateProductMenu(state);
                await updateSession(fromNumber, businessid, state.step, state.data);
                await sendWhatsAppMessage(fromNumber, menuData.text, menuData.options);
                return res.status(200).send('<Response></Response>');
            }

            else if (incomingMsg.includes('הגדרות דיוור')) {
                state.step = 'SET_MARKETING';
                await updateSession(fromNumber, businessid, state.step, state.data);
                
                const isConsented = customer && customer.marketingconsent ? 'מאושר' : 'לא מאושר';
                const marketingText = `הגדרות עדכונים ודיוור ✉️\nכרגע סטטוס הדיוור שלך הוא: *${isConsented}*.\n\nהאם תרצה לקבל מאיתנו עדכונים על מבצעים ותורים שהתפנו?\n1. כן, אשמח להצטרף\n2. לא, הסר אותי מהרשימה\n\n(הקש 0 לתפריט הראשי)`;
                
                await sendWhatsAppMessage(fromNumber, marketingText);
                return res.status(200).send('<Response></Response>');
            }

            else if (incomingMsg.includes('התורים שלי')) {
                const text = await handleMyAppointments(businessid, fromNumber, state);
                await updateSession(fromNumber, businessid, state.step, state.data);
                await sendWhatsAppMessage(fromNumber, text);
                return res.status(200).send('<Response></Response>');
            }

            else if (incomingMsg.includes('שעות פעילות')) {
                let hoursText = '*שעות הפעילות שלנו:*\n\n';
                if (profile.operatinghours) {
                    const daysHeb = { 'sunday':'ראשון', 'monday':'שני', 'tuesday':'שלישי', 'wednesday':'רביעי', 'thursday':'חמישי', 'friday':'שישי', 'saturday':'שבת' };
                    for (const [engDay, hebDay] of Object.entries(daysHeb)) {
                        const dayData = profile.operatinghours[engDay];
                        if (dayData && dayData.isOpen) {
                            hoursText += `יום ${hebDay}: ${dayData.start} - ${dayData.end}\n`;
                        } else {
                            hoursText += `יום ${hebDay}: סגור\n`;
                        }
                    }
                } else {
                    hoursText = 'שעות הפעילות טרם עודכנו במערכת.';
                }
                hoursText += '\n\n(הקש 0 לחזרה לתפריט)';
                await sendWhatsAppMessage(fromNumber, hoursText);
                return res.status(200).send('<Response></Response>');
            }

            else if (incomingMsg.includes('שאלות נפוצות')) {
                const faqMenu = await generateFAQMenu(businessid);
                
                if (!faqMenu) {
                    await sendWhatsAppMessage(fromNumber, 'מצטער, עדיין לא עודכנו שאלות נפוצות במערכת.\n\n(הקש 0 לחזרה)');
                    return res.status(200).send('<Response></Response>');
                }

                state.step = 'SELECT_FAQ';
                await updateSession(fromNumber, businessid, state.step, state.data);
                
                await sendWhatsAppMessage(fromNumber, faqMenu.text, faqMenu.options);
                return res.status(200).send('<Response></Response>');
            }

            else {
                await sendWhatsAppMessage(fromNumber, 'בחירה לא תקינה. אנא בחר אחת מהאפשרויות בתפריט (או הקש 0 לחזרה לראשי).');
                return res.status(200).send('<Response></Response>');
            }
        }

        else if (state.step === 'SELECT_CATEGORY') {
            const selectedCat = state.data.categories.find(c => incomingMsg.includes(c));
            
            if (selectedCat) {
                const servicesRes = await db.pool.query(`
                    SELECT s.*, COALESCE(c.CategoryName, 'כללי') as categoryname 
                    FROM Services s 
                    LEFT JOIN Service_Categories c ON s.categoryid = c.categoryid 
                    WHERE s.BusinessID=$1 AND COALESCE(c.CategoryName, 'כללי')=$2
                `, [businessid, selectedCat]);
                
                state.data.selectedCategory = selectedCat;
                state.data.filteredServices = servicesRes.rows;
                state.data.servicePage = 0;
                state.step = 'SELECT_SERVICE';
                
                const menuData = generateFilteredServiceMenu(state);
                await updateSession(fromNumber, businessid, state.step, state.data);
                await sendWhatsAppMessage(fromNumber, menuData.text, menuData.options);
            } else {
                await sendWhatsAppMessage(fromNumber, 'בחירה לא תקינה. אנא בחר קטגוריה מהתפריט או הקש 0 לחזרה.');
            }
            return res.status(200).send('<Response></Response>');
        }

        else if (state.step === 'SELECT_SERVICE') {
            if (incomingMsg.includes('טיפולים נוספים')) {
                state.data.servicePage += 1;
                const menuData = generateFilteredServiceMenu(state);
                await updateSession(fromNumber, businessid, state.step, state.data);
                await sendWhatsAppMessage(fromNumber, menuData.text, menuData.options);
                return res.status(200).send('<Response></Response>');
            } 
            else if (incomingMsg.includes('חזור אחורה')) {
                state.data.servicePage -= 1;
                const menuData = generateFilteredServiceMenu(state);
                await updateSession(fromNumber, businessid, state.step, state.data);
                await sendWhatsAppMessage(fromNumber, menuData.text, menuData.options);
                return res.status(200).send('<Response></Response>');
            }

            const selectedService = state.data.filteredServices.find(s => 
                incomingMsg.includes(s.servicename)
            );

            if (selectedService) {
                if (!state.data.cart) state.data.cart = [];
                
                // 💳 לוגיקת כרטיסיות מועדון (Punch Cards)
                // בודקים אם ללקוח יש כרטיסייה פעילה לטיפול הזה
                const cardRes = await db.pool.query(
                    `SELECT * FROM ClientCards 
                     WHERE BusinessID=$1 AND CustomerPhone=$2 AND ServiceID=$3 AND UsedPunches < TotalPunches AND Status='Active'`,
                    [businessid, fromNumber, selectedService.serviceid || selectedService.ServiceID]
                );

                // יצירת עותק של השירות כדי לא לדרוס את הנתונים המקוריים
                let itemToAdd = { ...selectedService };

                if (cardRes.rows.length > 0) {
                    const card = cardRes.rows[0];
                    itemToAdd.isPunchCard = true;
                    itemToAdd.cardId = card.cardid;
                    itemToAdd.originalPrice = itemToAdd.price;
                    itemToAdd.price = 0; // המחיר מתאפס כי זה ניקוב
                    itemToAdd.cartDisplayName = `${itemToAdd.servicename} (ניקוב כרטיסייה - נותרו ${card.totalpunches - card.usedpunches} טיפולים)`;
                } else {
                    itemToAdd.cartDisplayName = itemToAdd.servicename || itemToAdd.productname;
                }

                state.data.cart.push(itemToAdd);
                state.step = 'CART_DECISION';
                await updateSession(fromNumber, businessid, state.step, state.data);
                
                const cartTotal = state.data.cart.reduce((sum, item) => sum + parseInt(item.price || 0), 0);
                
                let cartListText = '';
                state.data.cart.forEach((item, index) => {
                    const note = item.pricenote ? ` (${item.pricenote})` : '';
                    cartListText += `${index + 1}. ${item.cartDisplayName} (${item.price} ₪${note})\n`;
                });
                
                const hasServices = state.data.cart.some(item => !item.itemType || item.itemType === 'service');
                const nextStepBtn = hasServices ? '🗓️ קביעת תאריך' : '💳 סיום קנייה';

                const reply = `✅ *${itemToAdd.cartDisplayName}* נוסף לעגלה.\n\n🛒 *מצב עגלה:*\n${cartListText}סה"כ לתשלום: ${cartTotal} ₪.\n\n💡 _להסרה הקלד 'X' ומספר (לדוגמה: X1)._\n\nמה תרצה לעשות כעת?`;
                
                const cartOptions = ['➕ הוסף טיפול נוסף', nextStepBtn, '🗑️ נקה עגלה'];
                await sendWhatsAppMessage(fromNumber, reply, cartOptions);
            } else {
                await sendWhatsAppMessage(fromNumber, 'בחירה לא תקינה. אנא בחר פריט מהתפריט או הקש 0 לחזרה.');
            }
            return res.status(200).send('<Response></Response>');
        }

        else if (state.step === 'SELECT_PRODUCT') {
            if (incomingMsg.includes('מוצרים נוספים')) {
                state.data.productPage += 1;
                const menuData = generateProductMenu(state);
                await updateSession(fromNumber, businessid, state.step, state.data);
                await sendWhatsAppMessage(fromNumber, menuData.text, menuData.options);
                return res.status(200).send('<Response></Response>');
            } 
            else if (incomingMsg.includes('חזור אחורה')) {
                state.data.productPage -= 1;
                const menuData = generateProductMenu(state);
                await updateSession(fromNumber, businessid, state.step, state.data);
                await sendWhatsAppMessage(fromNumber, menuData.text, menuData.options);
                return res.status(200).send('<Response></Response>');
            }

            const selectedProduct = state.data.products.find(p => incomingMsg.includes(p.productname));

            if (selectedProduct) {
                if (!state.data.cart) state.data.cart = [];
                // סימון הפריט כמוצר פיזי כדי שהבוט ידע לא לחפש לו תור ביומן
                selectedProduct.itemType = 'product';
                state.data.cart.push(selectedProduct);
                state.step = 'CART_DECISION';
                await updateSession(fromNumber, businessid, state.step, state.data);
                
                const cartTotal = state.data.cart.reduce((sum, item) => sum + parseInt(item.price || 0), 0);
                let cartListText = '';
                // מציג גם שמות של מוצרים וגם של טיפולים בעגלה!
                state.data.cart.forEach((item, index) => {
                    const note = item.pricenote ? ` (${item.pricenote})` : '';
                    cartListText += `${index + 1}. ${item.cartDisplayName || item.servicename || item.productname} (${item.price} ₪${note})\n`;
                });
                
                // לוגיקה חכמה: אם יש טיפול בעגלה ממשיכים לתאריך. אם רק מוצרים - ממשיכים לקופה.
                const hasServices = state.data.cart.some(item => !item.itemType || item.itemType === 'service');
                const nextStepBtn = hasServices ? '🗓️ קביעת תאריך' : '💳 סיום קנייה';

                const reply = `✅ *${selectedProduct.productname}* נוסף לעגלה.\n\n🛒 *מצב עגלה:*\n${cartListText}סה"כ: ${cartTotal} ₪.\n\n💡 _להסרה הקלד 'X' ומספר (לדוגמה: X1)._\n\nמה תרצה לעשות כעת?\n\n(הקש 0 לתפריט הראשי)`;
                
                const cartOptions = ['🛍️ המשך קניות', nextStepBtn, '🗑️ נקה עגלה'];
                await sendWhatsAppMessage(fromNumber, reply, cartOptions);
            } else {
                await sendWhatsAppMessage(fromNumber, 'בחירה לא תקינה. אנא בחר מוצר מהתפריט או הקש 0 לחזרה.');
            }
            return res.status(200).send('<Response></Response>');
        }
        
        else if (state.step === 'CART_DECISION') {
            // מאפשרים מחיקה דרך "הסר 1", "מחק 1" או "X1"
            if (incomingMsg.startsWith('הסר') || incomingMsg.startsWith('מחק') || incomingMsg.toUpperCase().startsWith('X')) {
                const numMatch = incomingMsg.match(/\d+/);
                
                if (numMatch) {
                    const itemIndex = parseInt(numMatch[0]) - 1; 

                    if (itemIndex >= 0 && itemIndex < state.data.cart.length) {
                        const removedItem = state.data.cart.splice(itemIndex, 1)[0]; 
                        const removedName = removedItem.cartDisplayName || removedItem.servicename || removedItem.productname;
                        
                        if (state.data.cart.length === 0) {
                            state.step = 'IDLE';
                            await updateSession(fromNumber, businessid, state.step, state.data);
                            await sendWhatsAppMessage(fromNumber, `🗑️ הפריט ${removedName} הוסר. העגלה ריקה כעת.\n\n(הקש 0 לתפריט הראשי)`);
                        } else {
                            await updateSession(fromNumber, businessid, state.step, state.data);
                            
                            let cartListText = '';
                            state.data.cart.forEach((item, index) => { 
                                const note = item.pricenote ? ` (${item.pricenote})` : '';
                                cartListText += `${index + 1}. ${item.cartDisplayName || item.servicename || item.productname} (${item.price} ₪${note})\n`; 
                            });
                            const cartTotal = state.data.cart.reduce((sum, item) => sum + parseInt(item.price || 0), 0);
                            
                            const hasServices = state.data.cart.some(item => !item.itemType || item.itemType === 'service');
                            const nextStepBtn = hasServices ? '🗓️ קביעת תאריך' : '💳 סיום קנייה';
                            const addBtn = hasServices ? '➕ הוסף טיפול נוסף' : '🛍️ המשך קניות';

                            const reply = `הפריט *${removedName}* הוסר.\n\n🛒 *מצב עגלה מעודכן:*\n${cartListText}סה"כ לתשלום: ${cartTotal} ₪.\n\nמה תרצה לעשות כעת?\n\n(הקש 0 לתפריט הראשי)`;
                            const cartOptions = [addBtn, nextStepBtn, '🗑️ נקה עגלה'];
                            await sendWhatsAppMessage(fromNumber, reply, cartOptions);
                        }
                    } else {
                        await sendWhatsAppMessage(fromNumber, "מספר פריט לא קשור לעגלה. אנא ודא שהקלדת 'X' ואחריו מספר הפריט.\n\n(הקש 0 לתפריט הראשי)");
                    }
                } else {
                    await sendWhatsAppMessage(fromNumber, "לא צוין מספר הפריט. אנא ודא שהקלדת 'X' ואחריו מספר שקיים בעגלה (לדוגמה: X1).\n\n(הקש 0 לתפריט הראשי)");
                }
                return res.status(200).send('<Response></Response>');
            }
            // מנתב חזרה לחנות הפיזית
            else if (incomingMsg.includes('המשך קניות')) {
                state.step = 'SELECT_PRODUCT';
                const menuData = generateProductMenu(state);
                await updateSession(fromNumber, businessid, state.step, state.data);
                await sendWhatsAppMessage(fromNumber, menuData.text, menuData.options);
                return res.status(200).send('<Response></Response>');
            }
            // מנתב לקופה עבור לקוח שקנה רק מוצרים (ללא תור)
            else if (incomingMsg.includes('סיום קנייה')) {
                state.step = 'CHECKOUT_PRODUCTS';
                await updateSession(fromNumber, businessid, state.step, state.data);
                await sendWhatsAppMessage(fromNumber, 'איך תרצה לקבל את ההזמנה? 📦\n1. איסוף עצמי מהסניף 📍\n2. משלוח עד הבית 🚚\n\n(הקש 0 לתפריט הראשי)');
                return res.status(200).send('<Response></Response>');
            }
            else if (incomingMsg.includes('טיפול נוסף') || incomingMsg === '1') {
                let categories = state.data.categories;
                if (!categories) {
                    const catRes = await db.pool.query(`
                        SELECT DISTINCT COALESCE(c.CategoryName, 'כללי') as categoryname 
                        FROM Services s 
                        LEFT JOIN Service_Categories c ON s.categoryid = c.categoryid 
                        WHERE s.BusinessID=$1
                    `, [businessid]);
                    categories = catRes.rows.map(r => r.categoryname);
                    state.data.categories = categories;
                }
                
                if (categories && categories.length === 1) {
                    state.step = 'SELECT_SERVICE';
                    state.data.servicePage = 0;
                    const menuData = generateFilteredServiceMenu(state); 
                    await updateSession(fromNumber, businessid, state.step, state.data);
                    await sendWhatsAppMessage(fromNumber, 'בחר טיפול נוסף מהרשימה:\n\n(הקש 0 לתפריט הראשי)', menuData.options);
                } else {
                    state.step = 'SELECT_CATEGORY';
                    const menuData = generateCategoryMenu(categories);
                    await updateSession(fromNumber, businessid, state.step, state.data);
                    await sendWhatsAppMessage(fromNumber, menuData.text, menuData.options);
                }
            } 
            else if (incomingMsg.includes('קביעת תאריך') || incomingMsg === '2') {
                const locRes = await db.pool.query('SELECT * FROM Locations WHERE BusinessID = $1 AND IsActive = TRUE', [businessid]);
                const locations = locRes.rows;

                if (locations.length > 1) {
                    state.data.locations = locations;
                    state.step = 'SELECT_LOCATION';
                    await updateSession(fromNumber, businessid, state.step, state.data);
                    
                    const locOptions = locations.map(l => l.locationname).slice(0, 10);
                    await sendWhatsAppMessage(fromNumber, 'באיזה סניף תרצה לקבוע את הטיפול? 📍\n(לחץ על התפריט לבחירה)\n\n(הקש 0 לתפריט הראשי)', locOptions);
                    return res.status(200).send('<Response></Response>');
                } else {
                    if (locations.length === 1) {
                        state.data.selectedLocation = locations[0];
                    } else {
                        state.data.selectedLocation = { locationid: null, locationname: 'ראשי', address: profile.address || 'לא צוינה כתובת' };
                    }
                    return await routeToStaffOrDate(state, fromNumber, businessid, res, sendWhatsAppMessage, updateSession, db);
                }
            }
            else if (incomingMsg.includes('נקה') || incomingMsg === '3') {
                state.data.cart = [];
                state.step = 'IDLE';
                await updateSession(fromNumber, businessid, state.step, state.data);
                await sendWhatsAppMessage(fromNumber, '🗑️ העגלה נוקתה. הקש 0 כדי להציג את התפריט הראשי מחדש.');
            } else {
                await sendWhatsAppMessage(fromNumber, 'אנא בחר אחת מהאפשרויות בתפריט או הקש 0 לחזרה לראשי.');
            }
            return res.status(200).send('<Response></Response>');
        }
        
        else if (state.step === 'CHECKOUT_PRODUCTS') {
            const deliveryMethod = incomingMsg.includes('1') || incomingMsg.includes('איסוף') ? 'Pickup' : 'Delivery';
            const cart = state.data.cart || [];
            const totalAmount = cart.reduce((sum, item) => sum + parseInt(item.price || 0), 0);
            
            // הגנה במקרה שהלקוח עדיין לא מזוהה לגמרי עם כל השדות
            const customerNameSafe = customer ? customer.customername : 'אורח';
            const customerAddressSafe = customer && customer.address ? customer.address : '';

            // 1. יצירת ההזמנה הראשית
            const orderRes = await db.pool.query(
                `INSERT INTO Orders (BusinessID, CustomerPhone, CustomerName, TotalAmount, DeliveryMethod, Address) 
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING OrderID`,
                [businessid, fromNumber, customerNameSafe, totalAmount, deliveryMethod, customerAddressSafe]
            );
            const orderId = orderRes.rows[0].orderid;

            // 2. רישום הפריטים ועדכון מלאי
            for (let item of cart) {
                if (item.itemType === 'product') {
                    // רישום הפריט
                    await db.pool.query(
                        `INSERT INTO Order_Items (OrderID, ProductID, PriceAtTime) VALUES ($1, $2, $3)`,
                        [orderId, item.productid, item.price]
                    );
                    // הורדת מלאי
                    await db.pool.query(
                        `UPDATE Products SET StockQuantity = StockQuantity - 1 WHERE ProductID = $1`,
                        [item.productid]
                    );
                }
            }

            const methodHeb = deliveryMethod === 'Pickup' ? 'איסוף עצמי מהסניף 📍' : 'משלוח עד הבית 🚚';
            const bizAddress = profile.address || 'כתובת העסק';
            
            let reply = `🎉 *ההזמנה שלך בוצעה בהצלחה!*\n\n📦 מספר הזמנה: ${orderId}\n💰 סה"כ: ${totalAmount} ₪\n🛵 שיטה: ${methodHeb}`;
            if (deliveryMethod === 'Pickup') reply += `\n📍 כתובת לאיסוף: ${bizAddress}`;
            reply += `\n\nתודה שקנית אצלנו! נעדכן אותך כשההזמנה תהיה מוכנה.\n\n(הקש 0 לתפריט הראשי)`;

            // ניקוי העגלה ואיפוס סטטוס
            state.step = 'IDLE';
            state.data = {};
            await updateSession(fromNumber, businessid, state.step, state.data);
            await sendWhatsAppMessage(fromNumber, reply);
            return res.status(200).send('<Response></Response>');
        }

        else if (state.step === 'SELECT_LOCATION') {
            const selectedLoc = state.data.locations.find(l => incomingMsg.includes(l.locationname));

            if (selectedLoc) {
                state.data.selectedLocation = selectedLoc;
                return await routeToStaffOrDate(state, fromNumber, businessid, res, sendWhatsAppMessage, updateSession, db);
            } else {
                await sendWhatsAppMessage(fromNumber, 'בחירה לא תקינה. אנא בחר סניף מהתפריט או הקש 0 לחזרה.');
                return res.status(200).send('<Response></Response>');
            }
        }

        else if (state.step === 'SELECT_STAFF') {
            const selectedStaff = state.data.staffList.find(s => incomingMsg.includes(s.staffname));

            if (selectedStaff) {
                state.data.selectedStaff = selectedStaff;
                state.step = 'SELECT_DATE';
                await updateSession(fromNumber, businessid, state.step, state.data);

                const d = new Date();
                const exampleDate = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}`;
                
                const locNameText = state.data.selectedLocation && state.data.selectedLocation.locationname !== 'ראשי' 
                    ? ` ב-${state.data.selectedLocation.locationname}` : '';
                    
                await sendWhatsAppMessage(fromNumber, `מעולה! הטיפול יבוצע ע"י *${selectedStaff.staffname}*${locNameText}.\nלבחירת תאריך הקלד/י בפורמט חודש.יום (לדוגמה: ${exampleDate}), או רשום/י 'מחר' או 'רביעי'. 🗓️\n\n(הקש 0 לתפריט הראשי)`);
            } else {
                await sendWhatsAppMessage(fromNumber, 'בחירה לא תקינה. אנא בחר איש צוות מהתפריט או הקש 0 לחזרה.');
            }
            return res.status(200).send('<Response></Response>');
        }

        else if (state.step === 'SELECT_FAQ') {
            const faqRes = await db.pool.query('SELECT answer FROM FAQs WHERE BusinessID = $1 AND question LIKE $2 LIMIT 1', 
                [businessid, `%${incomingMsg.substring(0, 15)}%`]);
            
            if (faqRes.rows.length > 0) {
                const answer = faqRes.rows[0].answer;
                const reply = `*תשובה:* \n${answer}\n\n💡 _ניתן לבחור שאלה נוספת מהתפריט או להקיש 0 לחזרה_`;
                
                await sendWhatsAppMessage(fromNumber, reply);
                const faqMenu = await generateFAQMenu(businessid);
                await sendWhatsAppMessage(fromNumber, 'שאלות נוספות:', faqMenu.options);
            } else {
                await sendWhatsAppMessage(fromNumber, 'לא מצאתי תשובה לשאלה הזו. נסה לבחור שוב מהתפריט או הקש 0 לנציג.');
            }
            return res.status(200).send('<Response></Response>');
        }
        
        else if (state.step === 'SET_MARKETING') {
            let consent = null;
            if (incomingMsg === '1' || incomingMsg.includes('כן')) consent = true;
            else if (incomingMsg === '2' || incomingMsg.includes('לא')) consent = false;

            if (consent !== null) {
                await db.pool.query('UPDATE Customers SET MarketingConsent = $1 WHERE CustomerPhone = $2 AND BusinessID = $3', [consent, fromNumber, businessid]);
                const responseText = consent ? 'מעולה! הוספתי אותך לרשימת התפוצה. 🎊' : 'אין בעיה, הסטטוס עודכן ולא תקבל הודעות שיווקיות. 👍';
                await sendWhatsAppMessage(fromNumber, responseText + '\n\n(הקש 0 לחזרה לתפריט)');
                state.step = 'IDLE';
                state.data = {};
            } else {
                await sendWhatsAppMessage(fromNumber, 'בחירה לא תקינה. אנא הקש 1 להצטרפות או 2 להסרה, או 0 לחזרה לראשי.');
            }
            return res.status(200).send('<Response></Response>');
        }

        else if (state.step === 'SELECT_DATE') {
            const dateStr = parseDate(incomingMsg);
            if (!dateStr) { replyText = 'תאריך לא תקין. אנא הקלד/י תאריך בפורמט חודש.יום, "מחר" או יום בשבוע.\n\n(הקש 0 לחזרה)'; } 
            else {
                state.data.selectedDate = dateStr;
                const blockedCals = profile.blocked_calendars || '';
                
                let calendarId = profile.googlecalendarid;
                if (state.data.selectedStaff && state.data.selectedStaff.googlecalendarid) {
                    calendarId = state.data.selectedStaff.googlecalendarid;
                }
                
                if (!calendarId) { 
                    await sendWhatsAppMessage(fromNumber, 'תקלה: יומן לא מוגדר למבצע השירות.\n\n(הקש 0 לחזרה)'); 
                    return res.status(200).send('<Response></Response>'); 
                }
  
                const reqDate = new Date(dateStr);
                const hebrewDay = reqDate.toLocaleDateString('he-IL', { weekday: 'long' }).replace('יום ', '');
                const daysMapHebToEng = { 'ראשון':'sunday', 'שני':'monday', 'שלישי':'tuesday', 'רביעי':'wednesday', 'חמישי':'thursday', 'שישי':'friday', 'שבת':'saturday' };
                const dayOfWeekEng = daysMapHebToEng[hebrewDay] || 'sunday';
                
                let startT = '09:00', endT = '18:00', isClosed = false;
                if (profile.operatinghours && profile.operatinghours[dayOfWeekEng]) {
                    if (profile.operatinghours[dayOfWeekEng].isOpen) {
                        startT = profile.operatinghours[dayOfWeekEng].start || '09:00';
                        endT = profile.operatinghours[dayOfWeekEng].end || '18:00';
                    } else { isClosed = true; }
                }

                if (isClosed) {
                    replyText = 'העסק סגור ביום זה. אנא בחר תאריך אחר:\n\n(הקש 0 לחזרה)';
                    await sendWhatsAppMessage(fromNumber, replyText);
                    return res.status(200).send('<Response></Response>');
                } else {
                    const maxGap = 20; 
                    const cartToPass = state.data.cart && state.data.cart.length > 0 ? state.data.cart : [state.data.selectedService];
                    const baseCartPrice = cartToPass.reduce((sum, item) => sum + parseInt(item.originalPrice || item.price || 0), 0); // המחיר הבסיסי ללא כרטיסיות

                    const slots = await scheduler.findFreeSlots(calendarId, blockedCals, dateStr, cartToPass, startT, endT, maxGap);
                    
                    const formattedSlots = [];
                    
                    // הגדרות תמחור דינמי (בעתיד יישלף מטבלת Business_Profile)
                    const PEAK_HOUR_START = 17; // שעות עומס מתחילות ב-17:00
                    const PEAK_SURCHARGE_PERCENT = 0.07; // תוספת 7% על עומס
                    const PRIORITY_DISCOUNT_PERCENT = 0.03; // הנחת 3% על סגירת חור (רציפות)

                    // עיבוד שעות מועדפות (Priority - חורים ביומן)
                    slots.prioritySlots.forEach(s => {
                        let finalPrice = baseCartPrice;
                        const hour = parseInt(s.split(':')[0]);
                        
                        // אם זה גם שעת שיא וגם מועדף - הבונוסים מתקזזים איכשהו, אבל ניתן הנחת רציפות מהמחיר הרגיל
                        finalPrice = finalPrice - (finalPrice * PRIORITY_DISCOUNT_PERCENT);
                        
                        // עיגול למספר שלם ללא אגורות!
                        finalPrice = Math.round(finalPrice);
                        
                        // הצגת המחיר החדש רק אם אין בעגלה ניקוב כרטיסייה שמכסה את הכל
                        const priceText = baseCartPrice > 0 ? `(₪${finalPrice})` : '(בכרטיסייה)';
                        formattedSlots.push(`${s} ⭐ ${priceText}`);
                    });

                    // עיבוד שעות רגילות
                    slots.regularSlots.forEach(s => {
                        let finalPrice = baseCartPrice;
                        const hour = parseInt(s.split(':')[0]);
                        
                        // האם זו שעת עומס? (ערב)
                        if (hour >= PEAK_HOUR_START) {
                            finalPrice = finalPrice + (finalPrice * PEAK_SURCHARGE_PERCENT);
                        }
                        
                        finalPrice = Math.round(finalPrice);
                        const priceText = baseCartPrice > 0 ? `(₪${finalPrice})` : '(בכרטיסייה)';
                        
                        // נוסיף אינדיקציה קטנה לשעות עומס
                        const peakIcon = hour >= PEAK_HOUR_START ? '🔥' : '';
                        formattedSlots.push(`${s} ${peakIcon} ${priceText}`.trim());
                    });

                    if (formattedSlots.length > 0) {
                        state.data.allSlots = formattedSlots;
                        state.data.page = 0;
                        state.step = 'SELECT_TIME';
                        
                        // נעדכן את ההודעה שתסביר על האייקונים
                        let explainText = `תורים פנויים ל-${state.data.selectedDate}:\n`;
                        explainText += `⭐ = הנחת רציפות\n🔥 = שעת עומס\n`;
                        explainText += `(לחץ על התפריט לבחירת שעה)`;
                        
                        const menuData = generateInteractiveMenuData(state);
                        menuData.text = explainText; // דורסים את הטקסט הגנרי
                        
                        await updateSession(fromNumber, businessid, state.step, state.data);
                        await sendWhatsAppMessage(fromNumber, menuData.text, menuData.options);
                        return res.status(200).send('<Response></Response>');
                    } else {
                        replyText = t('no_slots', gender, templates) + '\n\n(הקש 0 לחזרה)';
                        await sendWhatsAppMessage(fromNumber, replyText);
                        return res.status(200).send('<Response></Response>');
                    }
                }
            }
        }
        else if (state.step === 'SELECT_TIME') {
            const timePatternMatch = incomingMsg.match(/^(\d{1,2}):(\d{2})$/);
            const selectedSlot = state.data.allSlots.find(s => s.includes(incomingMsg) || s === incomingMsg);
            
            if (timePatternMatch && !state.data.allSlots.some(s => s.includes(incomingMsg))) {
                state.data.waitlistTime = incomingMsg;
                replyText = `השעה ${incomingMsg} תפוסה. תרצה להיכנס להמתנה?\n1. כן\n2. לא\n\n(הקש 0 לתפריט הראשי)`;
                state.step = 'CONFIRM_WAITLIST';
                
                await updateSession(fromNumber, businessid, state.step, state.data);
                await sendWhatsAppMessage(fromNumber, replyText);
                return res.status(200).send('<Response></Response>');
            }
            else if (incomingMsg.includes('הצג שעות מאוחרות') || incomingMsg === '10') {
                state.data.page += 1;
                const menuData = generateInteractiveMenuData(state);
                await updateSession(fromNumber, businessid, state.step, state.data);
                await sendWhatsAppMessage(fromNumber, menuData.text, menuData.options);
                return res.status(200).send('<Response></Response>');
            } 
            else if (incomingMsg.includes('חזור לשעות הקודמות') || incomingMsg === '1') {
                state.data.page = Math.max(0, state.data.page - 1);
                const menuData = generateInteractiveMenuData(state);
                await updateSession(fromNumber, businessid, state.step, state.data);
                await sendWhatsAppMessage(fromNumber, menuData.text, menuData.options);
                return res.status(200).send('<Response></Response>');
            } 
            else if (incomingMsg.includes('חפש בתאריך חדש')) {
                replyText = 'אנא הקלד את התאריך החדש שתרצה לבדוק:\n\n(הקש 0 לתפריט הראשי)';
                state.step = 'SELECT_DATE';
                await updateSession(fromNumber, businessid, state.step, state.data);
                await sendWhatsAppMessage(fromNumber, replyText);
                return res.status(200).send('<Response></Response>');
            } 
            else if (selectedSlot) {
                // 🛑 תיקון חילוץ השעה: מוציאים רק את הפורמט של HH:MM, כדי שהאימוג'ים והמחירים לא יהרסו את הקביעה
                const timeMatch = selectedSlot.match(/^\d{1,2}:\d{2}/);
                const time = timeMatch ? timeMatch[0] : selectedSlot.substring(0, 5); 
                
                const date = state.data.selectedDate;
                const cart = state.data.cart && state.data.cart.length > 0 ? state.data.cart : [state.data.selectedService];
                const combinedNames = cart.map(s => s.cartDisplayName || s.servicename || s.productname).join(' + ');
                const maxGap = 20;

                let calendarId = profile.googlecalendarid;
                if (state.data.selectedStaff && state.data.selectedStaff.googlecalendarid) {
                    calendarId = state.data.selectedStaff.googlecalendarid;
                }

                const bookRes = await scheduler.bookAppointment(
                    calendarId,
                    profile.blocked_calendars, 
                    date, 
                    time, 
                    cart, 
                    fromNumber, 
                    customer.customername,
                    maxGap
                );

                if (bookRes && bookRes.success) {
                    const status = cart[0].requiresapproval ? 'Pending' : 'Confirmed';

                    const staffId = state.data.selectedStaff ? state.data.selectedStaff.staffid : null;
                    const locId = state.data.selectedLocation ? state.data.selectedLocation.locationid : null;

                    for (let booked of bookRes.bookedEvents) {
                        await db.pool.query(
                            `INSERT INTO Appointments_Log (BusinessID, ServiceID, CustomerName, CustomerPhone, StartTime, EndTime, GoogleCalendarEventID, Status, StaffID, LocationID) 
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, 
                            [businessid, booked.serviceId, customer.customername, fromNumber, booked.start, booked.end, booked.eventId, status, staffId, locId]
                        );
                    }
                    
                    // ✅ עדכון ניקוב כרטיסייה לכל פריט שהגיע כ-PunchCard
                    for (let item of cart) {
                        if (item.isPunchCard) {
                            await db.pool.query('UPDATE ClientCards SET UsedPunches = UsedPunches + 1 WHERE CardID = $1', [item.cardId]);
                        }
                    }

                    const businessAddress = state.data.selectedLocation ? 
                        `${state.data.selectedLocation.locationname} - ${state.data.selectedLocation.address}` : 
                        (profile.address || 'לא צוינה במערכת');
                        
                    const staffNameText = state.data.selectedStaff ? `ע"י ${state.data.selectedStaff.staffname}` : '';
                    let successReply = `🎉 *תור (והזמנה) נקבעו בהצלחה!*\n\n📝 פרטים: ${combinedNames}\n🧑‍⚕️ מטפל/ת: ${staffNameText}\n🗓️ תאריך: ${date}\n🕒 שעת התחלה: ${time}\n📍 מיקום: ${businessAddress}`;
                    if(status === 'Pending') successReply += '\n\n(ממתין לאישור מנהל ⏳)';

                    await sendWhatsAppMessage(fromNumber, successReply);

                    // --- תחילת התיקון: יצירת לקוח אם הוא חדש לגמרי ---
                    if (!customer) {
                        try {
                            const newCustRes = await db.pool.query(
                                `INSERT INTO Customers (BusinessID, CustomerPhone, CustomerName, CreatedAt) 
                                 VALUES ($1, $2, $3, NOW()) RETURNING *`,
                                [businessid, fromNumber, state.data.customerName || 'לקוח חדש']
                            );
                            customer = newCustRes.rows[0];
                        } catch (err) {
                            console.error('Error creating new customer:', err.message);
                            // יצירת אובייקט דמי כדי למנוע קריסה בשורות הבאות
                            customer = { marketingconsent: false }; 
                        }
                    }
                    // --- סוף התיקון ---

                    if (customer.marketingconsent === null) {
                        state.step = 'ASK_MARKETING_AFTER_BOOKING';
                        await updateSession(fromNumber, businessid, state.step, state.data);
                        await sendWhatsAppMessage(fromNumber, `האם תרצה לקבל מאיתנו עדכונים על מבצעים ותורים שהתפנו?\n1. כן\n2. לא`);
                    } else {
                        state.step = 'IDLE';
                        state.data = {}; 
                        await updateSession(fromNumber, businessid, state.step, state.data);
                    }
                } else {
                    await sendWhatsAppMessage(fromNumber, 'חלק מהתורים נתפסו ברגע האחרון, לא ניתן היה לקבוע את הרצף. 😕\nאנא בחר שעה אחרת מהרשימה או הקלד תאריך.\n\n(הקש 0 לתפריט הראשי)');
                }
            } else {
                replyText = 'בחירה לא תקינה. אנא בחר מהרשימה, הקלד שעה להמתנה או הזן תאריך חדש (או הקש 0 לחזרה).';
                await sendWhatsAppMessage(fromNumber, replyText);
                return res.status(200).send('<Response></Response>');
            }
        }
        else if (state.step === 'CONFIRM_WAITLIST') {
            if (incomingMsg === '1' || incomingMsg.includes('כן')) {
                // שולפים את ה-ID של הטיפול הראשון מהעגלה
                const serviceId = state.data.cart && state.data.cart.length > 0 ? (state.data.cart[0].serviceid || state.data.cart[0].ServiceID) : null;
                
                await db.pool.query(
                    'INSERT INTO WaitingList (BusinessID, CustomerPhone, CustomerName, RequestedDate, RequestedTime, ServiceID) VALUES ($1, $2, $3, $4, $5, $6)', 
                    [businessid, fromNumber, customer.customername, state.data.selectedDate, state.data.waitlistTime, serviceId]
                );
                
                replyText = `מעולה! הוספתי אותך לרשימת ההמתנה ל-${state.data.selectedDate} בשעה ${state.data.waitlistTime}.\nאעדכן אותך מיד אם יתפנה מקום! 🕒`;
                state.step = 'IDLE';
                state.data = {};
            } else if (incomingMsg === '2' || incomingMsg.includes('לא')) {
                state.step = 'SELECT_TIME';
                const menuData = generateInteractiveMenuData(state);
                await updateSession(fromNumber, businessid, state.step, state.data);
                await sendWhatsAppMessage(fromNumber, menuData.text, menuData.options);
                return res.status(200).send('<Response></Response>');
            } else {
                await sendWhatsAppMessage(fromNumber, 'בחירה לא תקינה. אנא הקש 1 לאישור, 2 לחזרה, או 0 לתפריט הראשי.');
                return res.status(200).send('<Response></Response>');
            }
        }
        
        else if (state.step === 'ASK_MARKETING_AFTER_BOOKING') {
            if (incomingMsg.includes('1') || incomingMsg.includes('כן')) {
                await db.pool.query("UPDATE Customers SET MarketingConsent = true WHERE CustomerID=$1", [customer.customerid]);
                replyText = t('marketing_thank_yes', gender, templates);
            } else if (incomingMsg.includes('2') || incomingMsg.includes('לא')) {
                await db.pool.query("UPDATE Customers SET MarketingConsent = false WHERE CustomerID=$1", [customer.customerid]);
                replyText = t('marketing_thank_no', gender, templates);
            } else {
                await sendWhatsAppMessage(fromNumber, 'אנא הקש 1 להצטרפות, 2 להסרה, או 0 לחזרה לראשי.');
                return res.status(200).send('<Response></Response>');
            }
            state.step = 'IDLE';
            state.data = {}; 
        }
  
        else if (state.step === 'WRITE_TO_AGENT') {
            await db.pool.query(
                'INSERT INTO Messages (BusinessID, CustomerPhone, CustomerName, Content) VALUES ($1, $2, $3, $4)',
                [businessid, fromNumber, customer ? customer.customername : 'אורח', incomingMsg]
            );
            replyText = 'הודעה נשלחה. נציג יחזור אליך בהקדם.\n\n(הקש 0 לתפריט הראשי)'; 
            state.step = 'IDLE';
        }
  
        // --- רשת ביטחון ושליחת הודעות רגילות ---
        if (!replyText || replyText.trim() === '') {
            replyText = 'מצטער, לא הבנתי את בקשתך. 😕\nאנא הקש 0 כדי לחזור לתפריט הראשי בכל שלב.';
        }

        if (!res.headersSent) {
            await updateSession(fromNumber, businessid, state.step, state.data);
            await sendWhatsAppMessage(fromNumber, replyText);
            return res.status(200).send('<Response></Response>');
        }

    } catch (error) {
        console.error('❌ Webhook Error:', error);
        
        if (businessid_for_catch) {
            await updateSession(fromNumber, businessid_for_catch, 'IDLE', {});
        }
        
        if (!res.headersSent) {
            return res.status(500).send('<Response><Message>System Error</Message></Response>');
        }
    }
});

// --- פונקציות עזר ---
async function handleMyAppointments(businessid, phone, state) {
    const res = await db.pool.query(`SELECT * FROM Appointments_Log WHERE BusinessID = $1 AND CustomerPhone = $2 AND StartTime > NOW() AND Status IN ('Confirmed', 'Pending')`, [businessid, phone]);
    if (res.rows.length === 0) {
        state.step = 'IDLE';
        return 'אין תורים עתידיים.\n\n(הקש 0 לחזרה)';
    }
    else {
        let msg = 'התורים שלך:\n';
        res.rows.forEach((appt, i) => { msg += `${i+1}. ${new Date(appt.starttime).toLocaleString('he-IL')} - ${appt.servicename}\n`; });
        msg += '\nכדי לבטל, צור קשר עם נציג כרגע (בחר "דבר עם נציג" מהתפריט הראשי).\n\n(הקש 0 לחזרה)'; 
        state.step = 'IDLE';
        return msg;
    }
}

// פונקציית פענוח תאריכים חכמה 
function parseDate(msg) {
    if (!msg) return null;
    const text = msg.trim().replace('יום ', ''); 
    const today = new Date();
    
    if (text === 'היום') return today.toISOString().split('T')[0];
    if (text === 'מחר') {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        return tomorrow.toISOString().split('T')[0];
    }
    
    const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    for (let i = 0; i < days.length; i++) {
        if (text.includes(days[i])) {
            let targetDay = i;
            let currentDay = today.getDay();
            let daysToAdd = targetDay - currentDay;
            if (daysToAdd <= 0) daysToAdd += 7; 
            const targetDate = new Date(today);
            targetDate.setDate(today.getDate() + daysToAdd);
            return targetDate.toISOString().split('T')[0];
        }
    }

    const match = text.match(/^(\d{1,2})[\.\/](\d{1,2})/);
    if (match) {
        const day = parseInt(match[1], 10);
        const month = parseInt(match[2], 10);
        let year = today.getFullYear();
        
        const checkDate = new Date(year, month - 1, day);
        if (checkDate.getFullYear() === year && checkDate.getMonth() === month - 1 && checkDate.getDate() === day) {
            
            if (checkDate < today && checkDate.toDateString() !== today.toDateString()) {
                checkDate.setFullYear(year + 1); 
            }
            return checkDate.toISOString().split('T')[0];
        }
    }
    
    return null; 
}

// --- יצירת משתמש מנהל ראשוני (Seed) למקרה של התקנה חדשה ---
async function seedSuperAdmin() {
    try {
        const res = await db.pool.query("SELECT * FROM Admins");
        if (res.rows.length === 0) {
            const salt = await bcrypt.genSalt(10);
            const hash = await bcrypt.hash('admin123', salt);
            await db.pool.query("INSERT INTO Admins (Username, PasswordHash) VALUES ($1, $2)", ['admin', hash]);
            console.log("🌱 Seed: נוצר משתמש מנהל-על לבדיקות (Username: admin, Password: admin123)");
        }
    } catch (err) {
        console.error("⚠️ Seed Error: לא ניתן היה לבדוק/ליצור משתמש ראשוני. (האם הטבלאות נוצרו?)");
    }
}

// הפעלת השרת רק לאחר בדיקות תקינות של מסד הנתונים והזרקת נתונים
app.listen(port, async () => {
    console.log(`🚀 Server is up and running on port ${port}`);
    await db.testConnection(); // קורא לבדיקת החיבור מ-db.js
    await seedSuperAdmin();    // מוודא שיש משתמש למראיין
});