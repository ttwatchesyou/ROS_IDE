# ROS2 IDE Cloud Platform

แพลตฟอร์มพัฒนาและเรียนรู้ ROS 2 ผ่านเว็บ รองรับทั้งหุ่นยนต์จริงผ่าน Robot Agent และ local simulation แยก workspace/ROS domain ต่อหุ่นยนต์

## ความสามารถหลัก

- บัญชีผู้ใช้และการจัดการหุ่นยนต์
- Web editor, file tree และ PTY terminal หลายแท็บ
- Build/run/kill ROS 2 packages และ dashboard สำหรับ node/topic/process
- Topic monitor และ RViz-like 3D visualization
- Flow editor สำหรับสร้าง ROS 2 Python nodes
- URDF/TF/odometry, map และ 3D component editors
- Simulation พร้อม `/tf`, `/odom`, `/scan`, `/cmd_vel` และ occupancy map

## ส่วนประกอบ

- `server.js` — HTTP/WebSocket broker, authentication และ robot sessions
- `agent.js` — agent ที่ติดตั้งบนเครื่องหุ่นยนต์จริง
- `sim.js` — simulation runtime และ ROS package generators
- `public/` — browser IDE
- `schema.sql` — MySQL schema
- `install.sh` — agent installer ที่ server inject public URL ให้อัตโนมัติ

## เชื่อม Login ไปยังแอปอื่น

แอปหลักทำงานที่พอร์ต `3001` และแอปปลายทางอาจทำงานคนละ origin/port จึงอ่าน
`localStorage` ข้ามกันโดยตรงไม่ได้ ระบบใช้ One-time SSO code สำหรับส่ง Login
ไปยังแอปปลายทาง โดยพอร์ต `4000` ด้านล่างเป็นเพียงตัวอย่าง ไม่ใช่พอร์ตที่
ROS2 IDE จะเปิดให้อัตโนมัติ

ค่าเริ่มต้น `SHOW_SSO_DEBUG_KEY=false` จะไม่แสดง SSO Key ในหน้า Applications
และ redirect ไปยัง callback ของแอปปลายทางทันที

หลัง Login แอปหลักเก็บเฉพาะค่าอ้างอิงผู้ใช้ที่เข้ารหัสและ session token ไว้ใน
`localStorage` โดยไม่เก็บ `user_id` ตัวเลขตรง ๆ:

```js
const encryptedUserId = localStorage.getItem('encrypted_user_id');
const token = localStorage.getItem('token');
```

### ตั้งค่าแอปปลายทาง (ตัวอย่างพอร์ต 4000)

1. เปิดหน้า Applications ของระบบหลัก
2. เพิ่มหรือแก้ไขแอป โดยตั้ง Redirect URL เป็น
   `http://localhost:4000/auth/callback`
3. เลือก `One-time SSO code — สำหรับแอปภายนอก`
4. เมื่อกดเปิดแอป ระบบจะ redirect ไปยัง callback พร้อม `sso_code`

ตัวอย่าง callback ใน Node.js ซึ่งสมมติว่ารันที่พอร์ต 4000:

```js
app.get('/auth/callback', async (req, res) => {
  const response = await fetch(
    'http://127.0.0.1:3001/api/application-sessions/exchange',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: req.query.sso_code }),
    },
  );
  const result = await response.json();

  if (!response.ok || !result.ok) return res.status(401).send('SSO failed');

  // result.user.id คือ user_id จากระบบหลัก
  req.session.userId = result.user.id;
  req.session.username = result.user.username;
  req.session.role = result.user.role;
  res.redirect('/');
});
```

แอปปลายทางควรสร้าง session/cookie ของตัวเองหลังแลก code สำเร็จ ไม่ควรส่ง
`user_id` ผ่าน query string และไม่ควรเก็บ code ไว้ใช้งานซ้ำ เพราะ code ใช้ได้ครั้งเดียว
และหมดอายุภายใน 60 วินาที

### คำสั่งทดสอบขอ user_id

หลังจากกดเปิดแอป ให้คัดลอกค่า `sso_code` จาก URL callback แล้วทดสอบด้วย:

```bash
SSO_CODE='วางค่า-sso_code-ตรงนี้'

curl -sS -X POST 'http://127.0.0.1:3001/api/application-sessions/exchange' \
  -H 'Content-Type: application/json' \
  --data "{\"code\":\"$SSO_CODE\"}"
```

ผลลัพธ์ตัวอย่าง:

```json
{"ok":true,"user":{"id":12,"username":"student01","role":"user"},"applicationId":2}
```

การเรียกครั้งที่สองด้วย code เดิมจะได้ `401` ตามหลัก one-time code เมื่อ Logout
แอปหลักจะลบ `encrypted_user_id`, token และ session ออกจาก `localStorage`
ส่วนแอปปลายทางต้องล้าง session/cookie ของตัวเองด้วย

## ติดตั้ง server

Requirements: Node.js 20+, MySQL 8+, ROS 2 สำหรับใช้งาน local simulation

```bash
mysql -u root -p < schema.sql
npm ci

export DB_HOST=localhost
export DB_USER=ros2ide
export DB_PASS='replace-with-database-password'
export DB_NAME=ros2ide
export ENC_KEY='replace-with-a-long-random-secret'
export AUTH_TOKEN_SECRET='replace-with-a-long-random-login-token-secret'
export ADMIN_PASSWORD='replace-with-at-least-12-characters'

npm run setup
npm start
```

เปิด `http://localhost:3001` แล้วเพิ่ม robot จากหน้า Robots เครื่องหุ่นยนต์ติดตั้ง agent ด้วยคำสั่งที่หน้าเว็บสร้างให้

## Environment ที่สำคัญ

- `PORT` — HTTP port, ค่าเริ่มต้น `3001`
- `AUTH_TOKEN_SECRET` — secret สำหรับ signed login token ต้องเป็นค่าสุ่มยาวและเก็บเฉพาะฝั่ง server
- `PUBLIC_URL` — public URL เมื่ออยู่หลัง reverse proxy
- `CORS_ORIGINS` — origins ที่อนุญาต คั่นด้วย comma; ว่างหมายถึง same deployment/dev mode
- `ALLOW_REGISTRATION=true` — เปิด self-registration; ค่าเริ่มต้นปิด
- `ALLOW_UNSANDBOXED_SIM=true` — อนุญาต user ทั่วไปรัน simulation บน host โดยตรง
- `JSON_LIMIT` — request body limit, ค่าเริ่มต้น `10mb`
- `TRUST_PROXY=true` — ใช้เมื่อ deploy หลัง reverse proxy ที่เชื่อถือได้ เพื่ออ่าน client IP สำหรับ rate limit

## Membership และ Stripe Billing

หน้า Applications มีแพ็กเกจ Free (Simulation 2 ตัว + หุ่นจริง 2 ตัว), Pro รายเดือน
99 บาท, Pro รายปี 999 บาท และ Pro ตลอดชีพ 9,999 บาท ระบบจะให้สิทธิ์ Pro
หลัง webhook ที่ตรวจลายเซ็นจาก Stripe ยืนยันเท่านั้น พร้อมบันทึกวันสมัครและวันหมดอายุ

ตั้งค่า `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` และ `BILLING_PUBLIC_URL`
จากนั้นสร้าง webhook ที่:

```text
https://your-domain.example/api/billing/webhook
```

เลือก event อย่างน้อย `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`,
`invoice.payment_failed`, `customer.subscription.updated` และ
`customer.subscription.deleted` ควรทดสอบด้วย Stripe Test mode ให้ครบก่อนเปลี่ยนเป็น
Live keys โดยรายเดือน/รายปีใช้บัตรและต่ออายุอัตโนมัติ ส่วนตลอดชีพรองรับบัตรหรือ
PromptPay แบบชำระครั้งเดียว

## ข้อควรระวังด้าน simulation

Simulation สามารถ compile และรันโค้ดของผู้เรียนได้ จึงเทียบเท่าการให้สิทธิ์ shell ใน runtime นั้น ค่าเริ่มต้นอนุญาตเฉพาะ admin จนกว่าจะมี isolated runtime เช่น container/VM ต่อผู้ใช้ ห้ามเปิด `ALLOW_UNSANDBOXED_SIM` บน public server ที่มีผู้ใช้ที่ไม่ไว้วางใจ

## ตรวจสอบ

```bash
npm test
npm audit --omit=dev
```

ไฟล์ runtime ใน `sim_ws/`, `build/`, `install/` และ `log/` ไม่ใช่ source code และไม่ควร commit
