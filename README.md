# ZOE: Autonomous WhatsApp Booking & CRM SaaS 🤖📅

ZOE is a comprehensive, multi-tenant SaaS platform built to serve as a 24/7 virtual assistant for small businesses (salons, clinics, independent professionals). Operating entirely through WhatsApp, ZOE completely eliminates the friction of downloading dedicated apps or navigating clunky web portals. 

## 💡 The Business Value (What it does)

For the business owner, ZOE isn't just a scheduler; it's a revenue-optimizing engine:
* **Frictionless Booking:** Customers book, cancel, and manage appointments directly via conversational WhatsApp menus.
* **Dynamic Yield Management:** Automatically applies peak-hour surcharges or priority-slot discounts based on real-time schedule density.
* **Smart Waitlist:** When a cancellation occurs, ZOE instantly texts waitlisted customers and fills the gap, recovering lost revenue.
* **Automated CRM:** Sends pre-appointment reminders and post-appointment follow-ups, reducing no-shows and driving retention.
* **E-Commerce & Loyalty:** Built-in digital punch cards (Loyalty) and a mini-store for physical product checkouts.

---

## 🚀 Under the Hood: Engineering Highlights (How it works)

Building an autonomous booking engine requires moving beyond simple calendar inserts. ZOE actively optimizes the schedule using custom backend logic:

* **Smart Gap Filling (Anti-Dead-Time Algorithm):** Instead of showing all available slots and letting customers create 15-minute unbookable "dead zones," ZOE hunts for specific gaps. It prioritizes and forcefully suggests slots that perfectly align with existing appointments to ensure continuous work.
* **Asynchronous "Wait-Time" Scheduling:** ZOE splits complex services into `[Work -> Wait -> Work]` data segments (e.g., hair coloring where the dye needs 30 mins to set). The algorithm writes only the 'Work' blocks to Google Calendar, transparently allowing ZOE to book parallel clients during the 'Wait' overlaps, massively increasing daily capacity.
* **Headless Background Workers:** Built with `node-cron`, background processes run every 5 minutes to sweep the database, trigger waitlist notifications, dispatch CRM campaigns, and deliver daily operational briefs to the business owner via WhatsApp.
* **Multi-Tenant Architecture:** Scalable PostgreSQL schema utilizing Connection Pooling. Relational tables are paired with `JSONB` columns to allow flexible, per-business configurations (e.g., operating hours, dynamic templates) without schema migrations.
* **Server-to-Server (S2S) Calendar Sync:** 2-Way real-time synchronization utilizing Google Cloud Service Accounts for secure, zero-touch background authentication without manual OAuth token renewals.

## 🛠️ Tech Stack

* **Backend:** Node.js, Express.js (REST API & Webhook parsing)
* **Database:** PostgreSQL (Multi-tenant)
* **Integrations:** Twilio API (WhatsApp), Google Calendar API (v3)
* **Security:** Bcrypt password hashing, Helmet headers, API Rate Limiting, Environment-aware CORS
* **Frontend (Admin SPA):** Vanilla JavaScript, HTML5, CSS3 (Lightweight, zero-dependency Single Page Application)

---

## 💻 Local Setup & Development

### 1. Clone & Install
git clone [https://github.com/YourUsername/zoe-whatsapp-saas.git](https://github.com/YourUsername/zoe-whatsapp-saas.git)
cd zoe-whatsapp-saas
npm install
2. Database Initialization
This project uses PostgreSQL. Before running the application, you must initialize the database schema:

Create an empty PostgreSQL database (e.g., zoe_db).

Run the provided schema file to build the tables:

psql -U postgres -d zoe_db -f "-- DDL.txt"
(Note: Upon first launch, the server will automatically seed a Super Admin user. Credentials: admin / admin123).

3. Environment Configuration
Create a .env file in the root directory:

PORT=3000
DATABASE_URL=postgres://user:password@localhost:5432/zoe_db
TWILIO_ACCOUNT_SID=your_sid
TWILIO_AUTH_TOKEN=your_token
TWILIO_PHONE_NUMBER=whatsapp:+14155238886
SESSION_SECRET=your_secure_secret
4. Google Service Account Auth (Optional for Simulator)
Place your google-key.json (Service Account key) in the root directory. The Service Account email must have explicit "Make changes to events" permissions on the target Google Calendars.
If this file is missing, the system will safely boot in "Simulator Mode" and mock calendar events without crashing.

5. Run the Server
npm run dev
6. Webhook Simulation (Localhost via Twilio)
Use ngrok or Cloudflare Tunnels to expose your local port and bridge it to Twilio:

ngrok http 3000
Navigate to your Twilio WhatsApp Sandbox settings and set the "When a message comes in" webhook to: https://<your-ngrok-url>/webhook

🧪 Testing Without a Twilio Account (Postman Simulator)
You can seamlessly test the entire chatbot flow without a WhatsApp client or Twilio configuration. Simply send POST requests directly to the Webhook endpoint using Postman or cURL:

POST: http://localhost:3000/webhook

Headers: Content-Type: application/x-www-form-urlencoded

Body (x-www-form-urlencoded):

From: whatsapp:+972501234567 (Simulated customer number)

To: whatsapp:+14155238886 (Simulated bot number)

Body: שלום (The message text)

The server logs will print the bot's simulated replies directly in the console.
