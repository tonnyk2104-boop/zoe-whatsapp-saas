document.addEventListener('DOMContentLoaded', async () => {
    // בדיקת התחברות והרשאות
    try {
        const authRes = await fetch('/api/auth/status');
        const auth = await authRes.json();
        if (!auth.loggedIn || auth.businessId !== 'SUPER_ADMIN') {
            window.location.href = 'login.html';
            return;
        }
    } catch (e) {
        window.location.href = 'login.html';
        return;
    }

    // שימוש בנתיב יחסי
    const API_URL = '/api/businesses';
    
    const grid = document.getElementById('grid');
    const modalOverlay = document.getElementById('modalOverlay');
    const addBizBtn = document.getElementById('addBizBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const addForm = document.getElementById('addForm');

    // פונקציית עזר להודעות
    function showMsg(msg, type = 'success') {
        const el = document.getElementById('alertArea');
        el.innerHTML = msg;
        el.className = type === 'error' ? 'error-msg' : 'success-msg';
        el.style.display = 'block';
        setTimeout(() => el.style.display = 'none', 5000);
    }

    // פתיחת וסגירת מודל
    if (addBizBtn) {
        addBizBtn.addEventListener('click', () => {
            modalOverlay.style.display = 'flex';
        });
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            modalOverlay.style.display = 'none';
        });
    }

    // שליחת הטופס
    if (addForm) {
        addForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            await saveBusiness();
        });
    }

    async function load() {
        try {
            const res = await fetch(API_URL);
            if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
            
            const data = await res.json();
            grid.innerHTML = '';

            if (!Array.isArray(data) || data.length === 0) {
                grid.innerHTML = '<p style="grid-column: 1/-1; text-align: center;">אין עסקים עדיין.</p>';
                return;
            }

            data.forEach(biz => {
                const name = biz.businessname || biz.BusinessName;
                const phone = biz.whatsappnumber || biz.WhatsAppNumber;
                const id = biz.businessid || biz.BusinessID;
                
                const card = document.createElement('div');
                card.className = 'card';
                card.innerHTML = `
                    <h3>${name}</h3>
                    <p><strong>ID:</strong> ${id}</p>
                    <p><strong>טלפון:</strong> ${phone}</p>
                    <div class="card-footer">
                        <a href="manage.html?id=${id}">⚙️ ניהול עסק</a>
                    </div>
                `;
                grid.appendChild(card);
            });
        } catch (err) {
            console.error(err);
            grid.innerHTML = `<div class="error-msg">שגיאה בטעינת נתונים: ${err.message}<br>וודא שהשרת רץ (node index.js)</div>`;
        }
    }

    async function saveBusiness() {
        const name = document.getElementById('mName').value;
        const phone = document.getElementById('mPhone').value;
        const owner = document.getElementById('mOwner').value;
        const username = document.getElementById('mUsername').value; // חדש
        const password = document.getElementById('mPassword').value; // חדש

        try {
            const res = await fetch(API_URL, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                // שליחת כל המידע לשרת כולל שם משתמש וסיסמה
                body: JSON.stringify({ name, phone, ownerPhone: owner, username, password })
            });

            if (res.ok) {
                showMsg('העסק נוסף בהצלחה!');
                modalOverlay.style.display = 'none';
                addForm.reset();
                load();
            } else {
                const errData = await res.json();
                showMsg('שגיאה: ' + (errData.error || 'Unknown'), 'error');
            }
        } catch (err) {
            showMsg('שגיאת תקשורת', 'error');
        }
    }

    // הפעלה ראשונית
    load();
});