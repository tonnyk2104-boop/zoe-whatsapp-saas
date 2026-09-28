// קובץ: manage.js
// גרסה: 14.2 - סניטציה (Escape) למניעת חולשות XSS בתיבת ההודעות

const API_BASE = '/api';
let currentBusinessId = null;

// Caches
let servicesCache = [];
let productsCache = []; 
let customersCache = [];
let loyaltyCache = [];
let faqCache = [];
let staffCache = []; 
let currentSegments = []; 

// פונקציית סניטציה למניעת חולשות XSS בעת הזרקת תוכן גולשים למסך
function escapeHTML(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag]));
}

// --- אתחול המערכת ---
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const authRes = await fetch(`${API_BASE}/auth/status`);
        if (!authRes.ok) throw new Error('Auth failed');
        const auth = await authRes.json();
        
        if (!auth.loggedIn) { window.location.href = 'login.html'; return; }
        
       // משיכת ID מה-URL (עבור מנהל-על שנכנס לנהל עסק ספציפי)
        const urlParams = new URLSearchParams(window.location.search);
        const urlId = urlParams.get('id');
        
        currentBusinessId = urlId || auth.businessId;
        
        if (!currentBusinessId || currentBusinessId === 'SUPER_ADMIN') { 
            console.warn("No valid business ID found, redirecting to index..."); 
            window.location.href = 'index.html'; 
            return; 
        }

        // טעינת כל המודולים (לפי סדר תלויות)
        loadDashboard();
        await loadServices(); // ממתינים לטעינת הטיפולים כי אוטומציות וצוות תלויים בזה
        loadStaff();      
        loadProducts();   
        loadLoyalty();    
        loadFaq();        
        loadMessages();   
        loadCustomers();  
        loadSettings();   
        loadYieldSettings(); 
        loadAutomations(); 

    } catch (e) { 
        console.error('Init Error:', e); 
        // window.location.href = 'login.html'; // Uncomment inside production
    }
});

// --- Utility Functions ---
function switchTab(tabId, el) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    document.getElementById(tabId).classList.add('active');
}

function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function logout() { fetch(`${API_BASE}/auth/logout`, {method:'POST'}).then(() => window.location.href='login.html'); }


// ==============================================
// 1. דשבורד ואישורים 
// ==============================================
async function loadDashboard() {
    try {
        const res = await fetch(`${API_BASE}/dashboard/stats?businessId=${currentBusinessId}`);
        const data = await res.json();
        
        if(document.getElementById('stToday')) document.getElementById('stToday').innerText = data.stats.todayCount || 0;
        if(document.getElementById('stPending')) document.getElementById('stPending').innerText = data.stats.pendingCount || 0;
        if(document.getElementById('stRevenue')) document.getElementById('stRevenue').innerText = `₪${data.stats.expectedRevenue || 0}`;
        if(document.getElementById('stLowStock')) document.getElementById('stLowStock').innerText = data.lowStockProducts ? data.lowStockProducts.length : 0;

        const tbody = document.getElementById('approvalsList');
        if (tbody) {
            tbody.innerHTML = '';
            if (!data.pendingAppointments || data.pendingAppointments.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">אין תורים ממתינים לאישור 🎉</td></tr>';
            } else {
                data.pendingAppointments.forEach(appt => {
                    const dateObj = new Date(appt.starttime);
                    tbody.innerHTML += `
                        <tr>
                            <td><strong>${escapeHTML(appt.customername)}</strong><br><small>${appt.customerphone}</small></td>
                            <td>${appt.servicename}</td>
                            <td>${dateObj.toLocaleDateString('he-IL')} בשעה ${dateObj.toLocaleTimeString('he-IL', {hour:'2-digit', minute:'2-digit'})}</td>
                            <td>
                                <button class="btn-sm btn-success" onclick="approveAppt(${appt.appointmentid})">✅</button>
                                <button class="btn-sm btn-danger" onclick="rejectAppt(${appt.appointmentid})">❌</button>
                            </td>
                        </tr>`;
                });
            }
        }

        const stockBody = document.getElementById('inventoryAlertsList');
        if (stockBody) {
            stockBody.innerHTML = '';
            if (!data.lowStockProducts || data.lowStockProducts.length === 0) {
                stockBody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:20px;">המלאי תקין לחלוטין ✅</td></tr>';
            } else {
                data.lowStockProducts.forEach(p => {
                    stockBody.innerHTML += `
                        <tr>
                            <td><strong>${p.productname}</strong></td>
                            <td style="color:#e74c3c; font-weight:bold;">${p.stockquantity} <small>(סף: ${p.alertthreshold})</small></td>
                            <td><button class="btn-sm btn-outline" onclick="alert('יש לעבור למסך הקטלוג לחידוש מלאי')">חדש</button></td>
                        </tr>`;
                });
            }
        }
    } catch(e) { console.error("Dashboard Load Error", e); }
}

async function approveAppt(id) {
    if(!confirm('האם לאשר את התור?')) return;
    await fetch(`${API_BASE}/appointments/${id}/approve`, { method: 'POST' });
    loadDashboard();
}

async function rejectAppt(id) {
    if(!confirm('האם לדחות את התור?')) return;
    await fetch(`${API_BASE}/appointments/${id}/reject`, { method: 'POST' });
    loadDashboard();
}


// ==============================================
// 2. ניהול טיפולים
// ==============================================
async function loadServices() {
    const res = await fetch(`${API_BASE}/services?businessId=${currentBusinessId}`);
    servicesCache = await res.json();
    const tbody = document.getElementById('servicesList');
    if(!tbody) return;

    tbody.innerHTML = '';
    
    servicesCache.forEach(s => {
        let rules = [];
        if(s.requiresapproval) rules.push('🛡️ דורש אישור');
        if(s.issamedayonly) rules.push('⚡ מהיום-להיום');
        if(s.windowstart) rules.push(`🕒 ${s.windowstart}-${s.windowend}`);
        
        let totalTime = Array.isArray(s.durationdata) 
            ? s.durationdata.reduce((a,b)=>a+(b.duration||0),0) 
            : (s.durationdata || 0);

        tbody.innerHTML += `
            <tr>
                <td><strong>${s.servicename}</strong></td>
                <td>₪${s.price} <br><small style="color:#666;">${s.pricenote || ''}</small></td>
                <td>${totalTime} דק'</td>
                <td style="font-size:0.85em;">${rules.join('<br>')}</td>
                <td>
                    <button class="btn-sm" onclick="editService(${s.serviceid})">ערוך</button>
                    <button class="btn-sm btn-danger" onclick="deleteService(${s.serviceid})">מחק</button>
                </td>
            </tr>`;
    });
}

function openServiceModalNew() {
    document.getElementById('srvId').value = '';
    document.getElementById('srvName').value = '';
    document.getElementById('srvPrice').value = '';
    document.getElementById('srvPriceNote').value = '';
    document.getElementById('srvWinStart').value = '09:00';
    document.getElementById('srvWinEnd').value = '18:00';
    document.getElementById('srvSameDay').checked = false;
    document.getElementById('srvApproval').checked = false;
    currentSegments = [{ type: 'work', duration: 30 }];
    renderBuilder();
    document.getElementById('serviceModal').style.display = 'flex';
}

function editService(id) {
    const s = servicesCache.find(x => x.serviceid === id);
    document.getElementById('srvId').value = s.serviceid;
    document.getElementById('srvName').value = s.servicename;
    document.getElementById('srvPrice').value = s.price;
    document.getElementById('srvPriceNote').value = s.pricenote || '';
    document.getElementById('srvWinStart').value = s.windowstart || '09:00';
    document.getElementById('srvWinEnd').value = s.windowend || '18:00';
    document.getElementById('srvSameDay').checked = s.issamedayonly || false;
    document.getElementById('srvApproval').checked = s.requiresapproval || false;
    
    if (Array.isArray(s.durationdata)) {
        currentSegments = JSON.parse(JSON.stringify(s.durationdata));
    } else {
        currentSegments = [{ type: 'work', duration: parseInt(s.durationdata || 30) }];
    }
    
    renderBuilder();
    document.getElementById('serviceModal').style.display = 'flex';
}

function addSegment(type) { currentSegments.push({ type, duration: 15 }); renderBuilder(); }
function removeSegment(idx) { currentSegments.splice(idx, 1); renderBuilder(); }
function updateSegment(idx, val) { currentSegments[idx].duration = parseInt(val); renderBuilder(); }

function renderBuilder() {
    const container = document.getElementById('durationBuilder');
    if (!container) return;
    
    container.innerHTML = '';
    let total = 0;
    currentSegments.forEach((seg, i) => {
        total += (seg.duration || 0);
        container.innerHTML += `
            <div class="duration-segment">
                <span class="segment-type type-${seg.type}">${seg.type==='work'?'עבודה':'המתנה'}</span>
                <input type="number" value="${seg.duration}" onchange="updateSegment(${i}, this.value)" style="width:70px"> דק'
                <button class="btn-sm btn-danger" onclick="removeSegment(${i})" style="margin-right:auto;">X</button>
            </div>`;
    });
    document.getElementById('totalCalcTime').innerText = `סה"כ זמן: ${total} דק'`;
}

async function submitService() {
    const id = document.getElementById('srvId').value;
    const payload = {
        businessId: currentBusinessId,
        name: document.getElementById('srvName').value,
        price: document.getElementById('srvPrice').value,
        priceNote: document.getElementById('srvPriceNote').value,
        durationData: currentSegments,
        windowStart: document.getElementById('srvWinStart').value,
        windowEnd: document.getElementById('srvWinEnd').value,
        isSameDayOnly: document.getElementById('srvSameDay').checked,
        requiresApproval: document.getElementById('srvApproval').checked
    };
    
    const url = id ? `${API_BASE}/services/${id}` : `${API_BASE}/services`;
    const method = id ? 'PUT' : 'POST';
    await fetch(url, { method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
    closeModal('serviceModal');
    loadServices();
}

async function deleteService(id) {
    if(confirm('למחוק טיפול זה?')) { await fetch(`${API_BASE}/services/${id}`, { method: 'DELETE' }); loadServices(); }
}


// ==============================================
// 3. ניהול מוצרים ומלאי (E-commerce)
// ==============================================
async function loadProducts() {
    try {
        const res = await fetch(`${API_BASE}/products?businessId=${currentBusinessId}`);
        productsCache = await res.json();
        const tbody = document.getElementById('productsList');
        if(!tbody) return;

        tbody.innerHTML = '';
        if (productsCache.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">אין מוצרים בחנות.</td></tr>';
            return;
        }

        productsCache.forEach(p => {
            const stockColor = p.stockquantity <= p.alertthreshold ? '#e74c3c' : 'var(--text)';
            const stockBold = p.stockquantity <= p.alertthreshold ? 'bold' : 'normal';
            
            tbody.innerHTML += `
                <tr>
                    <td><strong>${p.productname}</strong></td>
                    <td>₪${p.price}</td>
                    <td style="color:${stockColor}; font-weight:${stockBold}">${p.stockquantity} יח'</td>
                    <td><small>מתחת ל-${p.alertthreshold}</small></td>
                    <td>${p.requiresapproval ? '✅ כן' : '❌ לא'}</td>
                    <td>
                        <button class="btn-sm btn-danger" onclick="deleteProduct(${p.productid})">מחק</button>
                    </td>
                </tr>`;
        });
    } catch(e) { console.error("Products Load Error", e); }
}

function openProductModal() {
    document.getElementById('prodName').value = '';
    document.getElementById('prodPrice').value = '';
    document.getElementById('prodStock').value = '10';
    document.getElementById('prodAlert').value = '5';
    document.getElementById('prodApproval').checked = false;
    document.getElementById('productModal').style.display = 'flex';
}

async function submitProduct() {
    const payload = {
        businessId: currentBusinessId,
        name: document.getElementById('prodName').value,
        price: document.getElementById('prodPrice').value,
        stock: document.getElementById('prodStock').value,
        alertThreshold: document.getElementById('prodAlert').value,
        requiresApproval: document.getElementById('prodApproval').checked
    };

    try {
        await fetch(`${API_BASE}/products`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        closeModal('productModal');
        loadProducts(); 
        loadDashboard(); 
    } catch(e) { alert('שגיאה ביצירת מוצר'); }
}

async function deleteProduct(id) {
    if(confirm('למחוק מוצר זה מהחנות?')) { 
        await fetch(`${API_BASE}/products/${id}`, { method: 'DELETE' }); 
        loadProducts(); 
        loadDashboard();
    }
}


// ==============================================
// 4. כרטיסיות מועדון (Loyalty)
// ==============================================
async function loadLoyalty() {
    try {
        const res = await fetch(`${API_BASE}/loyalty?businessId=${currentBusinessId}`);
        loyaltyCache = await res.json();
        renderLoyalty();
        
        const select = document.getElementById('loyaltyService');
        if(select && servicesCache.length > 0) {
            select.innerHTML = '<option value="">בחר טיפול...</option>';
            servicesCache.forEach(s => {
                select.innerHTML += `<option value="${s.serviceid}">${s.servicename}</option>`;
            });
        }
    } catch(e) { console.error(e); }
}

function renderLoyalty() {
    const filterInput = document.getElementById('searchLoyalty');
    const container = document.getElementById('loyaltyList');
    if (!container) return;

    container.innerHTML = '';
    const filter = filterInput ? filterInput.value : '';
    const list = filter ? loyaltyCache.filter(c => c.customerphone.includes(filter)) : loyaltyCache;

    if(list.length === 0) {
        container.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:20px; color:#999;">לא נמצאו כרטיסיות פעילות</div>';
        return;
    }

    list.forEach(c => {
        let dots = '';
        for(let i=0; i<c.totalpunches; i++) {
            const isUsed = i < c.usedpunches;
            dots += `<div class="punch-dot ${isUsed ? 'used' : ''}">${isUsed ? '✓' : ''}</div>`;
        }

        const isCompleted = c.status === 'Completed' || c.usedpunches >= c.totalpunches;
        const cardStyle = isCompleted ? 'background: linear-gradient(135deg, #7f8c8d 0%, #bdc3c7 100%);' : 'background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);';

        container.innerHTML += `
            <div class="loyalty-card-visual" style="${cardStyle}">
                <div style="display:flex; justify-content:space-between;">
                    <div style="font-weight:bold; font-size:1.1em;">${c.servicename || 'טיפול כללי'}</div>
                    ${isCompleted ? `<button class="btn-sm btn-danger" onclick="archiveCard(${c.cardid})" title="העבר לארכיון" style="background:transparent; border:1px solid white;">📦 הסתר</button>` : ''}
                </div>
                <div style="font-size:0.9em; margin-bottom:5px;">לקוח: ${c.customerphone}</div>
                ${c.notes ? `<div style="font-size:0.8em; font-style:italic; margin-bottom:5px; opacity:0.9;">📝 ${escapeHTML(c.notes)}</div>` : ''}
                
                <div class="punch-grid">${dots}</div>
                
                <div style="margin-top:15px; display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:0.8em;">${c.usedpunches}/${c.totalpunches} נוצלו</span>
                    ${!isCompleted ? 
                        `<button class="btn-sm" style="background:white; color:#667eea;" onclick="punchCard(${c.cardid})">➕ ניקוב ידני</button>` : 
                        `<span style="background:white; color:#2c3e50; padding:2px 6px; border-radius:4px; font-weight:bold; font-size:0.8em;">הושלם! 🎉</span>`}
                </div>
            </div>`;
    });
}

function openLoyaltyModal() {
    document.getElementById('loyaltyPhone').value = '';
    document.getElementById('loyaltyTotal').value = '10';
    document.getElementById('loyaltyNotes').value = '';
    document.getElementById('loyaltyPayment').value = 'Manual_Payment';
    document.getElementById('loyaltyModal').style.display = 'flex';
}

async function submitLoyaltyCard() {
    const submitBtn = document.querySelector('#loyaltyModal button[onclick="submitLoyaltyCard()"]') || 
                      document.querySelector('#loyaltyModal button[type="submit"]') ||
                      document.querySelector('#loyaltyModal button.btn-success');
    
    if(submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = 'מנפיק...';
    }

    let phoneInput = document.getElementById('loyaltyPhone').value.trim();
    if (phoneInput.startsWith('05')) {
        phoneInput = 'whatsapp:+972' + phoneInput.substring(1);
    } else if (!phoneInput.startsWith('whatsapp:')) {
        phoneInput = 'whatsapp:' + phoneInput;
    }

    const payload = {
        businessId: currentBusinessId, 
        customerPhone: phoneInput,
        serviceId: document.getElementById('loyaltyService').value,
        totalPunches: document.getElementById('loyaltyTotal').value,
        paymentMode: document.getElementById('loyaltyPayment').value,
        notes: document.getElementById('loyaltyNotes').value
    };
    
    if(!payload.serviceId) {
        if(submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = 'הנפק כרטיסייה';
        }
        return alert('נא לבחור טיפול');
    }

    try {
        const res = await fetch(`${API_BASE}/loyalty`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        if(res.ok) {
            closeModal('loyaltyModal');
            loadLoyalty();
        } else {
            alert('שגיאה ביצירה (אולי כבר קיימת כרטיסייה פעילה לטיפול זה?)');
        }
    } catch(e) { 
        alert('תקלה בתקשורת'); 
    } finally {
        if(submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = 'הנפק כרטיסייה'; 
        }
    }
}

async function archiveCard(id) {
    if(!confirm('להעביר את הכרטיסייה לארכיון? היא תוסתר מהמסך הראשי.')) return;
    await fetch(`${API_BASE}/loyalty/${id}/archive`, { method: 'PUT' });
    loadLoyalty();
}

async function punchCard(id) {
    if(!confirm('לבצע ניקוב ידני?')) return;
    await fetch(`${API_BASE}/loyalty/${id}/punch`, { method: 'PUT' });
    loadLoyalty();
}


// ==============================================
// 5. תפוצה ותבניות
// ==============================================
async function sendBroadcast() {
    const audience = document.getElementById('bcAudience').value;
    const message = document.getElementById('bcMessage').value;
    
    if(!message) return alert('נא לכתוב הודעה');
    if(!confirm(`לשלוח את ההודעה ל-${audience === 'All' ? 'כל הלקוחות' : audience}?`)) return;

    try {
        const res = await fetch(`${API_BASE}/broadcast`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ businessId: currentBusinessId, audience, message })
        });
        const data = await res.json();
        alert(`התהליך החל! נשלח ל-${data.count} לקוחות.`);
        document.getElementById('bcMessage').value = '';
    } catch(e) { alert('שגיאה בשליחה'); }
}

async function saveTemplates() {
    const templates = {};
    const ids = ['welcome_new', 'welcome_returning', 'menu_text', 'no_slots', 'priority_slots_found', 'choose_service'];
    ids.forEach(id => {
        const el = document.getElementById(`tpl_${id}`);
        if(el && el.value) templates[id] = el.value;
    });

    try {
        await fetch(`${API_BASE}/profile/${currentBusinessId}`, {
            method: 'PUT', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ templates }) 
        });
        alert('התבניות נשמרו בהצלחה!');
    } catch(e) { alert('שגיאה בשמירה'); }
}


// ==============================================
// 6. FAQ
// ==============================================
async function loadFaq() {
    try {
        const res = await fetch(`${API_BASE}/faq?businessId=${currentBusinessId}`);
        faqCache = await res.json();
        const tbody = document.getElementById('faqList');
        if (!tbody) return;

        tbody.innerHTML = '';
        faqCache.forEach(f => {
            tbody.innerHTML += `
                <tr>
                    <td>${escapeHTML(f.question)}</td>
                    <td>${escapeHTML(f.answer).substring(0, 50)}...</td>
                    <td><button class="btn-sm btn-danger" onclick="deleteFaq(${f.faqid})">מחק</button></td>
                </tr>`;
        });
    } catch(e) { console.error("FAQ Load Error", e); }
}

function openFaqModal() {
    document.getElementById('faqQuestion').value = '';
    document.getElementById('faqAnswer').value = '';
    document.getElementById('faqModal').style.display = 'flex';
}

async function submitFaq() {
    const q = document.getElementById('faqQuestion').value;
    const a = document.getElementById('faqAnswer').value;
    await fetch(`${API_BASE}/faq`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ businessId: currentBusinessId, question: q, answer: a })
    });
    closeModal('faqModal');
    loadFaq();
}

async function deleteFaq(id) {
    if(confirm('למחוק?')) { await fetch(`${API_BASE}/faq/${id}`, { method: 'DELETE' }); loadFaq(); }
}


// ==============================================
// 7. לקוחות והודעות (CRM & Inbox)
// ==============================================

// --- ניהול הודעות (Inbox) ---
async function loadMessages(filter = 'Unmanaged') {
    const res = await fetch(`${API_BASE}/messages?businessId=${currentBusinessId}`);
    let msgs = await res.json();
    
    if (filter === 'Unmanaged') {
        msgs = msgs.filter(m => m.status !== 'Handled');
    }

    const tbody = document.getElementById('messagesList');
    if (!tbody) return;

    tbody.innerHTML = '';
    msgs.forEach(m => {
        const isHandled = m.status === 'Handled';
        tbody.innerHTML += `
            <tr style="opacity: ${isHandled ? 0.6 : 1}">
                <td>${new Date(m.createdat).toLocaleDateString('he-IL')}</td>
                <td><strong>${escapeHTML(m.customername)}</strong><br><small>${m.customerphone}</small></td>
                <td>${escapeHTML(m.content)}</td>
                <td>${isHandled ? '✅ טופל' : '⏳ ממתין'}</td>
                <td>
                    <button class="btn-sm btn-success" onclick="updateMsgStatus(${m.messageid}, 'Handled')" ${isHandled ? 'disabled' : ''}>✓</button>
                    <button class="btn-sm btn-danger" onclick="deleteMessage(${m.messageid})">🗑️</button>
                    <a href="https://wa.me/${m.customerphone.replace('+','')}" target="_blank" class="btn-sm btn-outline">השב</a>
                </td>
            </tr>`;
    });
    
    const unmanagedCount = msgs.filter(m => m.status !== 'Handled').length;
    const badge = document.getElementById('msgCountBadge');
    if (badge) {
        badge.innerText = unmanagedCount;
        badge.style.display = unmanagedCount > 0 ? 'inline' : 'none';
    }
}

async function updateMsgStatus(id, status) {
    await fetch(`${API_BASE}/messages/${id}/status`, {
        method: 'PUT', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ status })
    });
    loadMessages();
}

async function deleteMessage(id) {
    if(!confirm('למחוק את ההודעה?')) return;
    await fetch(`${API_BASE}/messages/${id}`, { method: 'DELETE' });
    loadMessages();
}

// --- ניהול לקוחות (CRM) ---
function openAddCustomerModal() {
    document.getElementById('newCustName').value = '';
    document.getElementById('newCustPhone').value = '';
    document.getElementById('addCustomerModal').style.display = 'flex';
}

async function submitNewCustomer() {
    const payload = {
        businessId: currentBusinessId,
        name: document.getElementById('newCustName').value,
        phone: document.getElementById('newCustPhone').value,
        gender: document.getElementById('newCustGender').value
    };

    await fetch(`${API_BASE}/customers`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    });
    closeModal('addCustomerModal');
    loadCustomers();
}

async function loadCustomers() {
    const res = await fetch(`${API_BASE}/customers?businessId=${currentBusinessId}`);
    customersCache = await res.json();
    renderCustomers();
}

function renderCustomers() {
    const filter = document.getElementById('searchCustomer').value;
    const tbody = document.getElementById('customersList');
    if(!tbody) return;

    tbody.innerHTML = '';
    const list = filter ? customersCache.filter(c => c.customername?.includes(filter) || c.customerphone.includes(filter)) : customersCache;
    
    list.forEach(c => {
        const marketingIcon = c.marketingconsent ? '✅' : '❌';
        const genderMap = { 'Male': '👨 זכר', 'Female': '👩 נקבה', 'neutral': '⚪ ניטרלי' };
        
        tbody.innerHTML += `
            <tr>
                <td>${escapeHTML(c.customername)}</td>
                <td>${c.customerphone}</td>
                <td>${genderMap[c.gender] || c.gender}</td>
                <td>${c.status}</td>
                <td>${marketingIcon}</td> 
                <td><button class="btn-sm" onclick="editCustomer(${c.customerid})">ערוך</button></td>
            </tr>`;
    });
}

function editCustomer(id) {
    const c = customersCache.find(x => x.customerid === id);
    if (!c) return;

    document.getElementById('custId').value = c.customerid;
    document.getElementById('custName').value = c.customername;
    document.getElementById('custPhone').value = c.customerphone;
    document.getElementById('custGender').value = c.gender || 'neutral';
    document.getElementById('custStatus').value = c.status;
    
    const mktCheck = document.getElementById('custMarketing');
    if(mktCheck) mktCheck.checked = c.marketingconsent === true;
    
    document.getElementById('customerModal').style.display = 'flex';
}

async function submitCustomer() {
    const id = document.getElementById('custId').value;
    const marketingEl = document.getElementById('custMarketing');
    
    const payload = {
        name: document.getElementById('custName').value,
        gender: document.getElementById('custGender').value,
        status: document.getElementById('custStatus').value,
        marketingConsent: marketingEl ? marketingEl.checked : false
    };

    await fetch(`${API_BASE}/customers/${id}`, {
        method: 'PUT', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    });
    closeModal('customerModal');
    loadCustomers();
}


// ==============================================
// 8. הגדרות ושעות פעילות
// ==============================================
async function loadSettings() {
    try {
        const res = await fetch(`${API_BASE}/businesses/${currentBusinessId}`);
        const data = await res.json();
        
        if(document.getElementById('bizTitle')) document.getElementById('bizTitle').innerText = `ניהול: ${data.business.businessname}`;
        
        if(document.getElementById('sBizName')) document.getElementById('sBizName').value = data.business.businessname;
        if(document.getElementById('sCalId')) document.getElementById('sCalId').value = data.profile.googlecalendarid || '';
        if(document.getElementById('sBlockedCals')) document.getElementById('sBlockedCals').value = data.profile.blocked_calendars || '';
        
        // טעינת קישור למטא ורשתות חברתיות
        const serverUrl = window.location.origin;
        if(document.getElementById('metaVerificationLink')) document.getElementById('metaVerificationLink').value = `${serverUrl}/verify/${currentBusinessId}`;
        if(document.getElementById('bizFacebookUrl')) document.getElementById('bizFacebookUrl').value = data.profile.facebook_url || '';
        if(document.getElementById('bizInstagramUrl')) document.getElementById('bizInstagramUrl').value = data.profile.instagram_url || '';

        // עדכון: טעינת מידע קיים עבור שם הבעלים והכתובת
        if(document.getElementById('bizOwnerName')) document.getElementById('bizOwnerName').value = data.business.ownername || '';
        if(document.getElementById('bizAddress')) document.getElementById('bizAddress').value = data.profile.address || '';

        const tpl = data.profile.templates || {};
        const ids = ['welcome_new', 'welcome_returning', 'menu_text', 'no_slots', 'priority_slots_found', 'choose_service'];
        ids.forEach(id => {
            const el = document.getElementById(`tpl_${id}`);
            if(el) el.value = tpl[id] || '';
        });

        renderOperatingHours(data.profile.operatinghours || {});

    } catch (e) { console.error("Settings Load Error", e); }
}

function renderOperatingHours(hoursData) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const daysHeb = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    const container = document.getElementById('operatingHoursContainer');
    if (!container) return;

    container.innerHTML = '';
    
    days.forEach((day, idx) => {
        const data = hoursData[day] || { isOpen: true, start: '09:00', end: '18:00' };
        container.innerHTML += `
            <div class="hours-row">
                <div class="hours-day">${daysHeb[idx]}</div>
                <input type="checkbox" class="day-check" data-day="${day}" ${data.isOpen ? 'checked' : ''}> פעיל
                <input type="time" class="day-start" data-day="${day}" value="${data.start || '09:00'}">
                - 
                <input type="time" class="day-end" data-day="${day}" value="${data.end || '18:00'}">
            </div>
        `;
    });
}

async function saveSettings() {
    const operatingHours = {};
    document.querySelectorAll('.day-check').forEach(chk => {
        const day = chk.dataset.day;
        const start = document.querySelector(`.day-start[data-day="${day}"]`).value;
        const end = document.querySelector(`.day-end[data-day="${day}"]`).value;
        operatingHours[day] = { isOpen: chk.checked, start, end };
    });

    const payload = {
        calendarId: document.getElementById('sCalId').value,
        blockedCalendars: document.getElementById('sBlockedCals').value,
        operatingHours: operatingHours,
        facebookUrl: document.getElementById('bizFacebookUrl').value,
        instagramUrl: document.getElementById('bizInstagramUrl').value,
        // עדכון: שליחת השדות החדשים לשרת כחלק מה-payload
        ownerName: document.getElementById('bizOwnerName').value,
        address: document.getElementById('bizAddress').value
    };

    await fetch(`${API_BASE}/profile/${currentBusinessId}`, {
        method: 'PUT', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    });
    alert('הגדרות כלליות ושעות פעילות נשמרו!');
}

// ==============================================
// 9. תמחור דינמי (Yield Management)
// ==============================================
async function loadYieldSettings() {
    try {
        const res = await fetch(`${API_BASE}/businesses/${currentBusinessId}`);
        const data = await res.json();
        const settings = data.profile.yield_settings || {};
        
        if (document.getElementById('yieldEnabled')) document.getElementById('yieldEnabled').checked = settings.enabled || false;
        if (document.getElementById('yieldPeakSurcharge')) document.getElementById('yieldPeakSurcharge').value = settings.peak_surcharge_percent || 7;
        if (document.getElementById('yieldPriorityDiscount')) document.getElementById('yieldPriorityDiscount').value = settings.priority_discount_percent || 3;
        if (document.getElementById('yieldPeakHour')) document.getElementById('yieldPeakHour').value = settings.peak_start_hour || 17;
        if (document.getElementById('yieldRoundTo')) document.getElementById('yieldRoundTo').value = settings.round_to || 5;
        
        renderYieldPreview(settings);
    } catch(e) {
        console.error("Yield Settings Load Error", e);
    }
}

function renderYieldPreview(settings) {
    const tbody = document.getElementById('yieldPreviewList');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    const surcharge = (settings.peak_surcharge_percent || 7) / 100;
    const discount = (settings.priority_discount_percent || 3) / 100;
    const roundTo = parseInt(settings.round_to || 5);

    servicesCache.forEach(s => {
        const base = parseInt(s.price);
        const peakPrice = Math.round((base + (base * surcharge)) / roundTo) * roundTo;
        const priorityPrice = Math.round((base - (base * discount)) / roundTo) * roundTo;
        
        tbody.innerHTML += `
            <tr>
                <td>${s.servicename}</td>
                <td>₪${base}</td>
                <td style="color:#e67e22; font-weight:bold;">₪${peakPrice}</td>
                <td style="color:#27ae60; font-weight:bold;">₪${priorityPrice}</td>
            </tr>`;
    });
}

async function saveYieldSettings() {
    const settings = {
        enabled: document.getElementById('yieldEnabled').checked,
        peak_surcharge_percent: parseInt(document.getElementById('yieldPeakSurcharge').value),
        priority_discount_percent: parseInt(document.getElementById('yieldPriorityDiscount').value),
        peak_start_hour: parseInt(document.getElementById('yieldPeakHour').value),
        round_to: parseInt(document.getElementById('yieldRoundTo').value)
    };

    try {
        await fetch(`${API_BASE}/profile/${currentBusinessId}`, {
            method: 'PUT', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ yield_settings: settings })
        });
        
        renderYieldPreview(settings);
        alert('הגדרות התמחור הדינמי עודכנו!');
    } catch (e) {
        console.error("Save Yield Settings Error:", e);
        alert('שגיאה בשמירת הגדרות התמחור');
    }
}

// ==============================================
// 10. אוטומציות הודעות (Automations)
// ==============================================
async function loadAutomations() {
    try {
        const res = await fetch(`${API_BASE}/automations?businessId=${currentBusinessId}`);
        const data = await res.json();
        const tbody = document.getElementById('automationsList');
        if(!tbody) return;

        tbody.innerHTML = '';
        data.forEach(a => {
            const triggerHeb = a.triggertype === 'PRE_APPOINTMENT' ? 'לפני' : 'אחרי';
            const serviceName = a.serviceid ? servicesCache.find(s => s.serviceid === a.serviceid)?.servicename : 'כל הטיפולים';
            
            tbody.innerHTML += `
                <tr>
                    <td>${serviceName}</td>
                    <td>${Math.abs(a.offsetminutes)} דק'</td>
                    <td>${triggerHeb}</td>
                    <td style="font-size:0.8em; color:#666;">${escapeHTML(a.messagetemplate).substring(0, 40)}...</td>
                    <td><button class="btn-sm btn-danger" onclick="deleteAutomation(${a.messageid})">מחק</button></td>
                </tr>`;
        });

        const select = document.getElementById('autoService');
        if(select) {
            select.innerHTML = '<option value="">כל הטיפולים</option>';
            servicesCache.forEach(s => select.innerHTML += `<option value="${s.serviceid}">${s.servicename}</option>`);
        }
    } catch (e) {
        console.error("Automations Load Error", e);
    }
}

function openAutomationModal() { 
    document.getElementById('automationModal').style.display = 'flex'; 
}

function addTag(tag) { 
    document.getElementById('autoTemplate').value += tag; 
}

async function submitAutomation() {
    const payload = {
        businessId: currentBusinessId, 
        serviceId: document.getElementById('autoService').value,
        triggerType: document.getElementById('autoTrigger').value,
        offsetMinutes: parseInt(document.getElementById('autoOffset').value) * (document.getElementById('autoTrigger').value === 'PRE_APPOINTMENT' ? -1 : 1),
        template: document.getElementById('autoTemplate').value
    };

    try {
        await fetch(`${API_BASE}/automations`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        closeModal('automationModal');
        loadAutomations();
    } catch (e) {
        console.error("Save Automation Error", e);
        alert('שגיאה בשמירת האוטומציה');
    }
}

async function deleteAutomation(id) {
    if(confirm('למחוק את האוטומציה הזו?')) {
        try {
            await fetch(`${API_BASE}/automations/${id}`, { method: 'DELETE' });
            loadAutomations();
        } catch (e) {
            console.error("Delete Automation Error", e);
        }
    }
}

// ==============================================
// 11. ניהול צוות עובדים (Staff)
// ==============================================
async function loadStaff() {
    try {
        const res = await fetch(`${API_BASE}/staff?businessId=${currentBusinessId}`);
        staffCache = await res.json();
        const tbody = document.getElementById('staffList');
        if(!tbody) return;

        tbody.innerHTML = '';
        if (staffCache.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">לא הוגדרו אנשי צוות בעסק.</td></tr>';
            return;
        }

        staffCache.forEach(emp => {
            const isActive = emp.isactive ? '✅ פעיל' : '❌ מושהה';
            tbody.innerHTML += `
                <tr style="opacity: ${emp.isactive ? 1 : 0.6}">
                    <td><strong>${escapeHTML(emp.staffname)}</strong><br><small>${emp.services.length} טיפולים משויכים</small></td>
                    <td>${emp.phone || '-'}</td>
                    <td style="font-size:0.85em; color:#666;">${emp.googlecalendarid || '-'}</td>
                    <td>${isActive}</td>
                    <td>
                        <button class="btn-sm" onclick="editStaff(${emp.staffid})">ערוך</button>
                        <button class="btn-sm btn-danger" onclick="deleteStaff(${emp.staffid})">מחק</button>
                    </td>
                </tr>`;
        });
    } catch(e) { console.error("Staff Load Error", e); }
}

function openStaffModal() {
    document.getElementById('staffModalTitle').innerText = 'איש צוות חדש';
    document.getElementById('staffId').value = '';
    document.getElementById('staffName').value = '';
    document.getElementById('staffPhone').value = '';
    document.getElementById('staffCalendar').value = '';
    document.getElementById('staffActive').checked = true;
    
    renderStaffServicesCheckboxes([]);
    document.getElementById('staffModal').style.display = 'flex';
}

function editStaff(id) {
    const emp = staffCache.find(x => x.staffid === id);
    if (!emp) return;

    document.getElementById('staffModalTitle').innerText = 'עריכת איש צוות';
    document.getElementById('staffId').value = emp.staffid;
    document.getElementById('staffName').value = emp.staffname;
    document.getElementById('staffPhone').value = emp.phone || '';
    document.getElementById('staffCalendar').value = emp.googlecalendarid || '';
    document.getElementById('staffActive').checked = emp.isactive;
    
    renderStaffServicesCheckboxes(emp.services || []);
    document.getElementById('staffModal').style.display = 'flex';
}

function renderStaffServicesCheckboxes(selectedServiceIds) {
    const container = document.getElementById('staffServicesList');
    container.innerHTML = '';
    
    if (servicesCache.length === 0) {
        container.innerHTML = '<span style="color:#e74c3c; grid-column:1/-1;">יש להקים טיפולים במערכת לפני שיוך עובדים.</span>';
        return;
    }

    servicesCache.forEach(srv => {
        const isChecked = selectedServiceIds.includes(srv.serviceid) ? 'checked' : '';
        container.innerHTML += `
            <label style="display:flex; align-items:center; gap:5px; cursor:pointer; font-weight:normal; font-size:0.9em;">
                <input type="checkbox" class="staff-srv-cb" value="${srv.serviceid}" ${isChecked}>
                ${srv.servicename}
            </label>
        `;
    });
}

async function submitStaff() {
    const selectedServices = [];
    document.querySelectorAll('.staff-srv-cb:checked').forEach(cb => {
        selectedServices.push(parseInt(cb.value));
    });

    const payload = {
        businessId: currentBusinessId, 
        staffId: document.getElementById('staffId').value || null,
        name: document.getElementById('staffName').value,
        phone: document.getElementById('staffPhone').value,
        calendarId: document.getElementById('staffCalendar').value,
        isActive: document.getElementById('staffActive').checked,
        serviceIds: selectedServices
    };

    try {
        await fetch(`${API_BASE}/staff`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        closeModal('staffModal');
        loadStaff(); 
    } catch(e) { alert('שגיאה בשמירת איש צוות'); }
}

async function deleteStaff(id) {
    if(confirm('למחוק איש צוות זה? (תורים עתידיים שלו ביומן גוגל לא יימחקו)')) { 
        await fetch(`${API_BASE}/staff/${id}`, { method: 'DELETE' }); 
        loadStaff(); 
    }
}

// ==============================================
// 12. פונקציות נוספות
// ==============================================
function copyMetaLink() {
    const copyText = document.getElementById("metaVerificationLink");
    if (copyText) {
        copyText.select();
        copyText.setSelectionRange(0, 99999); 
        navigator.clipboard.writeText(copyText.value).then(() => {
            alert("הקישור הועתק בהצלחה! ניתן להדביק אותו כעת בטופס של מטא.");
        });
    }
}