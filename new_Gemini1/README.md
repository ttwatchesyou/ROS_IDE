# ROS2 IDE Cloud Platform

แพลตฟอร์มพัฒนาและเรียนรู้ ROS 2 ผ่านเว็บ รองรับทั้งหุ่นยนต์จริงผ่าน Robot Agent และ local simulation แยก workspace/ROS domain ต่อหุ่นยนต์

## Template แขนกลและหุ่นยนต์ขา (หุ่นยนต์จริง)

Robot Config มี Template แขนกล 6 แกนพร้อมกริปเปอร์, Humanoid 14 ข้อต่อ และ
Quadruped 12 ข้อต่อ รวมถึงหมวดชิ้นส่วน Servo, ท่อนแขน/ขา, กริปเปอร์, ลำตัว,
ศีรษะ และเท้า ปรับแกนหมุนและ joint limits ได้ใน Property ของข้อต่อ
โมเดลและ URDF เก็บโครงสร้าง parent/child และข้อต่อ revolute เมื่อบันทึก
ค่าขนาด แรงบิด ความเร็ว และ inertia เป็นตัวอย่าง ต้องปรับให้ตรงกับฮาร์ดแวร์

นำ `src/sim_robot_tf/urdf/robot.urdf` เข้า MoveIt Setup Assistant เพื่อสร้าง
planning groups, SRDF, kinematics และ controllers ก่อนใช้วางแผนหรือควบคุมจริง
แพ็กเกจ TF เดิมแสดงท่าประกอบคงที่ ไม่ใช่ตัวขับข้อต่อ ให้หยุด static TF ชุดนี้ก่อน
ใช้ robot_state_publisher และ joint_states จาก controller ของ MoveIt
Template หุ่นยนต์ขาเป็นโมเดลเริ่มต้น ไม่รวมการทรงตัวหรือ gait controller
อ้างอิง [MoveIt Setup Assistant](https://moveit.picknik.ai/main/doc/examples/setup_assistant/setup_assistant_tutorial.html)

Template และชิ้นส่วนกลุ่มนี้แสดงเฉพาะหุ่นยนต์จริง ลำดับภารกิจ Sim คงเดิม

## ความสามารถหลัก

- บัญชีผู้ใช้และการจัดการหุ่นยนต์
- Web editor, file tree และ PTY terminal หลายแท็บ
- Build/run/kill ROS 2 packages และ dashboard สำหรับ node/topic/process
- Topic monitor และ RViz-like 3D visualization
- Flow editor สำหรับสร้าง ROS 2 Python nodes
- URDF/TF/odometry, map และ 3D component editors
- Simulation พร้อม `/tf`, `/odom`, `/scan`, `/cmd_vel` และ occupancy map

### ภารกิจ 0 สำหรับหุ่นยนต์จริง

ROS Wizzard ของหุ่นยนต์จริงเริ่มจากภารกิจ 0 เพื่อตรวจ Ubuntu, สถาปัตยกรรมเครื่อง,
APT และเครื่องมือ ROS 2 ที่จำเป็นก่อนปลดล็อกภารกิจประกอบหุ่น ระบบรองรับคู่รุ่น
Ubuntu 22.04 (Jammy) + ROS 2 Humble และ Ubuntu 24.04 (Noble) + ROS 2 Jazzy
บน amd64/arm64 โดยสามารถติดตั้ง ROS 2 รุ่นที่ตรงกับ Ubuntu, colcon, rosdep
รวมถึงแพ็กเกจพื้นฐานที่ขาดผ่าน Robot Agent ได้ ต้องยืนยันก่อนติดตั้งและใช้
รหัสผ่าน sudo จากหน้า Robot Connection หากเครื่องไม่ได้ตั้ง passwordless sudo
ระบบจะไม่ติดตั้ง ROS 2 ข้ามคู่รุ่นและไม่อัปเกรด Ubuntu ให้อัตโนมัติ

ภารกิจ 0 และ API ติดตั้งนี้ปฏิเสธ Simulation โดยตรง ลำดับภารกิจและ runtime ของ
Simulation จึงคงเดิม

การ Save สนาม 3D, Apply Map และ Save SLAM ใช้คิวเดียวกัน ครั้งละหนึ่งงาน และใช้ `flock`
ที่ `sim_ws/.runtime-leases/mapsim-build.lock` ป้องกันงานหนักซ้อนกันระหว่าง
Node/PM2 หลาย process ที่ใช้โฟลเดอร์นี้ร่วมกัน ต้องมีคำสั่ง `flock` (util-linux)
บนเครื่องเซิร์ฟเวอร์ ตั๋วคิวใน `.runtime-leases/map-jobs` เรียง FIFO ข้าม process
และกดซ้ำระหว่างรอจะได้งานเดิม การบันทึกสนามจะตรวจคิวก่อนเขียน `map.json`
Build ใช้ worker เดียวและใช้ผล build เดิมถ้า source ไม่เปลี่ยน
หน้าเว็บรับ job ID ทันทีแล้วอ่านสถานะทุก 2 วินาที จึงไม่ติด HTTP timeout เพราะรอคิว
ลำดับคิวที่แสดงรวมทุก process ที่ใช้โฟลเดอร์เดียวกัน สถานะงานเก็บบนดิสก์และล้าง
เมื่อมีงานใหม่หลังครบ 10 นาที หากเซิร์ฟเวอร์รีสตาร์ตกลางงานจะแจ้ง interrupted
ไม่รันงานซ้ำด้วย session เก่า ผู้ใช้กด Save ใหม่ได้ โดยไฟล์ที่บันทึกแล้วยังอยู่

Simulation ใช้ spatial index ตรวจ LiDAR, เก็บผลสแกนเมื่อ pose ไม่เปลี่ยน,
และส่ง SLAM map เฉพาะเมื่อหุ่นเปลี่ยน pose (สูงสุด 2 Hz) ข้อมูลล่าสุดยังเป็น latched
สำหรับผู้เปิด RViz ทีหลัง ส่วน TF/odom/scan ยังส่งที่ 10 Hz ตามเดิม
Dashboard ของทุก Simulation ใช้ host metrics/process snapshot ร่วมกันทุก 5 วินาที
และกรอง process ตาม workspace ก่อนส่งให้ผู้ใช้ ขอบเขต grid รวมกำแพงจริงจำกัด
ไม่เกิน 400,000 cells ทั้งใน API และ Python runtime

RViz ของ Simulation ใช้ ROS bridge ร่วมกันตาม workspace และชุด topic ผู้เปิดหลายแท็บ
จึงรับข้อมูลจาก bridge เดียวกัน ผู้เปิดทีหลังจะได้ latest TF/odom/scan/map snapshot ทันที
และ client ที่รับข้อมูลไม่ทันจะข้าม telemetry ระหว่างทางแทนการสะสมคิว ส่วนหุ่นยนต์จริง
ยังใช้ bridge realtime แยกตาม connection เหมือนเดิม คำสั่งควบคุมและการแก้สถานะไม่ถูก cache

ข้อมูลที่ไม่ realtime มี cache อายุสั้นใน process ได้แก่ membership และ application catalog
30 วินาที โดย Stripe webhook และการแก้ catalog จะล้างรายการที่เกี่ยวข้องทันที ส่วน auth
รวมเฉพาะ query ที่เข้าพร้อมกันและไม่เก็บผลหลัง query เสร็จ จึงคงพฤติกรรม revoke เดิม ค่า TTL
ปรับได้ด้วย `MEMBERSHIP_CACHE_MS`, `APPLICATION_CATALOG_CACHE_MS` และระยะเก็บ Sim RViz
หลังแท็บสุดท้ายปิดปรับด้วย `SIM_RVIZ_IDLE_CACHE_MS`

ตรวจ regression ด้วย `npm test`; ทดสอบ ROS/RViz จริง 20 workspace ด้วย
`ROSIDE_TEST_ROS=1 ROSIDE_TEST_MULTIUSER=1 node --test --test-name-pattern='twenty real ROS workspaces' test/regression.test.js`
การทดสอบนี้ใช้ ROS Jazzy บนเครื่องเดียวกัน สร้าง workspace ชั่วคราวแยก 20 ตัว
และทำความสะอาดหลังจบ จึงควรรันช่วงที่เครื่องมีทรัพยากรว่าง

## จูน Navigation ใน Simulation

หน้า Navigation มี template ปลอดภัย / สมดุล / ทางแคบ และปรับละเอียดได้ 12 ค่า
ค่าที่ Apply จะเก็บแยกตาม workspace และโหลดกลับเมื่อเปิดหน้าใหม่
ระยะห้ามเข้าใกล้วัตถุวัดจากศูนย์กลางหุ่น = `radius + clearance`
(ค่าเริ่มต้น 0.24 + 0.08 = 0.32 m) โดย planner เผื่อขนาด cell เพิ่มด้วย
`inflation` เป็นเขต cost เพื่อเลือกทางห่างวัตถุ ไม่ใช่รัศมีหุ่น
ระบบบังคับ inflation ไม่น้อยกว่า radius + clearance; template ทางแคบลดความเร็ว
และระยะเผื่อ แต่ไม่ลดรัศมีหุ่นต่ำกว่า footprint จำลองจริง 0.24 m

Costmap ใช้ exact distance transform O(cells) และ cache เมื่อ Map/ค่าระยะไม่เปลี่ยน
A* จำกัด CPU ต่อคำขอ 20–150 ms (ค่าเริ่มต้น 60 ms) และ 18,000 expansions
งบนี้ไม่รวมการสร้าง distance field ครั้งแรกเมื่อเปลี่ยน Map
ตรวจ line-of-sight ทั้งตอนเลือก waypoint และก่อนเดิน จึงไม่ตัดมุมผ่านวัตถุ
เป้าที่ใกล้วัตถุเกินไปจะถูกปฏิเสธ ไม่ย้ายไปจุดอื่นแล้วต่อเส้นกลับเข้าอุปสรรค
หยุดเมื่อไม่คืบหน้า 20 วินาที และพักก่อน replan ไม่วนคำนวณทุก tick
ระหว่างวิ่ง Navigation จะไม่สร้าง SLAM map ซ้ำ แต่ TF/odom/scan ยังทำงานตามเดิม
สถานะกำลังเดิน/ปรับมุม/ไม่มีทาง/ถึงเป้ามาจาก controller ผ่าน RViz stream

นี่คือ Simulation controller ที่มีพารามิเตอร์แนว Nav2 ไม่ใช่ Nav2 เต็ม stack
ไม่เปลี่ยนพารามิเตอร์หุ่นจริงที่เชื่อมต่ออยู่ เมื่อ Export จะเขียนค่า Nav2 ที่สอดคล้องกัน
โดยใช้ radius + clearance เป็นรัศมีวงกลมเผื่อความปลอดภัยในไฟล์ export;
ค่า budget/replan/obstacle (ระยะชะลอ) เฉพาะ Simulation ไม่ได้แปลงเป็น Nav2 parameter
ควรตรวจ footprint และจูนใหม่ก่อนนำ export ไปใช้กับหุ่นจริง
อ้างอิงแนวคิด [Nav2 inflation layer](https://docs.nav2.org/jazzy/configuration_and_development/configuration_guide/core_servers/costmap_2d/costmap_plugins/inflation/)

ทดสอบ path/clearance/controller โดยไม่เปิด ROS: `node --test test/navigation.test.js`
เพิ่ม `ROSIDE_TEST_MULTIUSER_NAV=1` ในคำสั่งทดสอบ 20 workspace ข้างบน
เพื่อให้ทั้ง 20 ตัววางแผนและวิ่งอ้อมวัตถุพร้อมกัน พร้อมวัด CPU รวมเครื่อง
ชุดนี้ใช้ ROS จริงและ RViz bridges แต่ไม่ใช่ browser rendering 20 หน้าต่าง

ผลทดสอบวันที่ 9 ก.ย. 2026: 20 workspace, สนาม 10×10 m มีกล่อง 2 ใบ
Build/เปิดครบใน 139 วินาที; วิ่ง Navigation พร้อมกันถึงเป้าครบ 20 ตัวใน 21 วินาที
ช่วงวิ่ง CPU รวมเครื่องเฉลี่ย 37%, odometry ต่ำสุดประมาณ 8.7 Hz
เป็นผลเฉพาะเครื่องและภาระงานขณะทดสอบ ไม่ใช่การรับประกัน CPU สำหรับทุกขนาดสนาม

ทดสอบซ้ำบนเครื่อง Xeon E5-1620 v3, RAM 15 GiB และดิสก์หมุน วันที่ 21 ก.ย. 2026
โดยใช้ ROS Jazzy จริง, RViz WebSocket หนึ่ง connection ต่อ Simulation และ Navigation พร้อมกัน:

| Sim พร้อมกัน | เปิดครบ | CPU stream | CPU Navigation | RAM available | Odom ต่ำสุด | สำเร็จ |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 20 | 139 s | 11% | 20% | 9,575 MiB | 8.7 Hz | 20/20 |
| 30 | 212 s | 17% | 31% | 8,462 MiB | 8.5 Hz | 30/30 |
| 40 | 285 s | 23% | 46% | 7,363 MiB | 8.5 Hz | 40/40 |

ตัวเลขนี้ไม่รวมการ render browser ซึ่งทำงานบนเครื่องผู้ใช้ ขีดจำกัด runtime ที่ทดสอบผ่านคือ
40 Sim แต่ขีดจำกัด UX สำหรับการเปิดพร้อมกันต่ำกว่าเพราะ build ใช้ worker เดียวบน HDD
แนะนำ soft limit 30 และ hard limit 40 จนกว่าจะเปลี่ยนเป็น SSD หรือทดสอบสูงกว่านี้
กำหนดจำนวนทดสอบด้วย `ROSIDE_TEST_MULTIUSER_COUNT` (1–60)
ทดสอบฟอร์ม/ปุ่มใน Chrome เพิ่มเติมได้ด้วย
`ROSIDE_TEST_BROWSER=1 node --test test/navigation-browser.test.js`

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
# Online / Local สำหรับหุ่นยนต์จริง — Agent 2.4.0

สำรองก่อนแก้ไว้เป็น ROSIDE v1.0.2 แล้ว เพิ่ม Local IDE บนหุ่นยนต์, optional Agent capabilities, ปุ่มอัปเดต Agent และคลังชิ้นส่วนร่วม โดยรักษา legacy Online protocol และแยก Sim ออกจาก Local runtime

วิธีติดตั้ง/ใช้งาน ขอบเขตการทดสอบ ข้อจำกัด offline และการกู้คืน: [ONLINE_LOCAL_README.md](ONLINE_LOCAL_README.md)
