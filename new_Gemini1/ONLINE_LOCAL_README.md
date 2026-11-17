# ROSIDE Online / Local — Agent 2.4.2

## ขอบเขต

- Backup ก่อนแก้: `/home/ubuntu/ROSIDE_BACKUPS/ROSIDE-v1.0.2.tar.gz` พร้อม checksum และวิธีคืน
- ใช้เฉพาะหุ่นยนต์จริง ไม่เปลี่ยน Sim engine, ROS domain, MapSim queue หรือ workspace ของ Sim
- Agent เดิมที่ไม่ส่ง version/capabilities ยังใช้ Online ตาม protocol เดิม
- Local ใช้ backend เครื่องมือหุ่นยนต์ชุดเดียวกับ Cloud แต่ไม่สร้าง connection MySQL ไม่เริ่ม Sim และปิด Cloud admin/billing/Sim APIs

```text
Online browser → Cloud broker ─┐
                              ├→ Agent บนหุ่นยนต์ → ROS / workspace / hardware
Local browser → Local broker ─┘
                  (บนหุ่นยนต์)
```

## วิธีใช้

Agent 2.4.2 ตรวจรุ่นใหม่ทุก 5 นาทีและอัปเดตอัตโนมัติเมื่อไม่มีงานหรือ Terminal, ไม่มีคำสั่งขับเคลื่อนบน `/cmd_vel` อย่างน้อย 3 วินาที และ ROS topic ชนิด `std_msgs/msg/Bool` ส่ง `true` ต่อเนื่องว่ามอเตอร์ถูกปิดและห้ามรับคำสั่ง ก่อนติดตั้ง Agent รุ่นเดิมต้องอัปเดตด้วยตนเองหนึ่งครั้ง แล้วเปิดหน้าต่าง `⇄` เพื่อบันทึกชื่อ topic แบบเต็ม เช่น `/robot/update_safe` ถ้าไม่ตั้ง topic ระบบไม่อัปเดตอัตโนมัติ ตัวเฝ้าสัญญาณใน systemd unit แยกตรวจทั้งสอง topic ตลอดการติดตั้ง หากสัญญาณปิดมอเตอร์หายหรือมีคำสั่ง `/cmd_vel` ไม่เป็นศูนย์ จะหยุดติดตั้งและหยุด Agent ด้วย ต้องตรวจ interlock แล้วเริ่ม Agent ด้วยตนเอง รุ่นที่ล้มเหลวจะไม่ลองอัตโนมัติซ้ำจนกว่าจะมี release ใหม่ ตรวจสถานะได้ในหน้าต่าง Agent และ `~/.ros2ide/auto-update-attempt.json` ต้องใช้ Cloud URL แบบ HTTPS/WSS และ ROS 2/rclpy บนหุ่นยนต์

ทุกครั้งที่ Cloud เริ่มหรือไฟล์เว็บ/Agent ที่บรรจุใน release เปลี่ยน Cloud จะตรวจ fingerprint และสร้าง release ใหม่โดยอัตโนมัติ Agent 2.4.2 เทียบ SHA-256 ของ release กับชุดที่ติดตั้งอยู่ จึงอัปเดตเว็บ Local ได้แม้ยังเป็นเวอร์ชัน Agent เดิม เมื่อผ่านเงื่อนไขความปลอดภัยเดียวกัน หน้า Agent แสดง SHA ของเว็บบนหุ่นและ Cloud ให้ตรวจความตรงกัน

รายการเปิดใช้บนหุ่นยนต์จริง:

- [ ] ยืนยันว่า topic เป็น `std_msgs/msg/Bool`; `true` หมายถึงมอเตอร์ปิดและไม่รับคำสั่งจริงตลอดช่วงอัปเดต และส่งถี่พอให้ค่าล่าสุดไม่เกิน 1.5 วินาที
- [ ] อัปเดต Agent รุ่นเดิมเป็น 2.4.2 ด้วยตนเองหนึ่งครั้งขณะหุ่นยนต์ปลอดภัย
- [ ] ในหน้า Agent บันทึกชื่อ topic ของหุ่นตัวนั้น เมื่อเปิดใช้งาน ระบบตรวจ release ทุก 5 นาที
- [ ] ดูเวอร์ชันล่าสุดและรายการเปลี่ยนแปลงในหน้า Agent และทดสอบหนึ่งตัวก่อนเปิดใช้ทั้งชุด

หน้าเว็บหุ่นยนต์แสดง IP ของเครื่องที่ Cloud มองเห็นชัดเจน เมื่อกด “เริ่มภารกิจ” จะตรวจใหม่ทุกครั้งกับ Agent ของหุ่นตัวที่เลือก: Cloud เทียบ IP ของเครื่องที่เปิดเว็บ (จากการเชื่อมต่อเว็บหรือ proxy ที่เชื่อถือได้) กับ subnet ของ Agent แล้วให้ Agent ping IP นั้น หากตรงและตอบกลับ รวมทั้ง Local broker พร้อม Cloud จะส่งสิทธิ์ครั้งเดียวและรหัส sudo ที่บันทึกไว้กับหุ่นตัวนั้นผ่าน Agent จากนั้นเปิด `http://<robot-ip>:3080/` และเข้า IDE อัตโนมัติ เบราว์เซอร์ไม่เห็นรหัส sudo; สิทธิ์ครั้งเดียวอยู่ใน URL fragment และหมดอายุใน 60 วินาที หาก Agent ยังไม่รองรับหรือยืนยัน LAN ไม่ได้จะใช้ Cloud พร้อมแถบเตือนความหน่วง การ์ดหุ่นแสดง IP/URL ของ Agent และแสดง URL Local สำหรับตรวจเครือข่ายเมื่อ Cloud มองเห็นเพียง IP ของ VPN/อินเทอร์เน็ต การตรวจนี้ต้องให้ browser เข้าถึง IP หุ่นจริงด้วย และ firewall ต้องอนุญาต ping กับพอร์ต Local หาก Cloud อยู่หลัง proxy บน loopback ให้ตั้ง `TRUST_PROXY=true`; ถ้ามี proxy หลายชั้นให้ตั้ง `TRUST_PROXY_HOPS` ให้ตรงจำนวนชั้นที่เชื่อถือได้ (ค่าเริ่มต้น 1) การเข้า Local ผ่าน HTTP ควรใช้เฉพาะ LAN ส่วนตัวที่เชื่อถือได้

ถ้า IP ที่ Cloud เห็นตรงกับ IP interface ของ Agent ตัวเดียวกัน ระบบถือเป็นเส้นทางเครื่องเดียวกัน แม้เป็น Tailnet `100.64.0.0/10` ที่ใช้ netmask `/32`; จะให้ Agent ping และตรวจ Local broker ก่อนเปิด URL ของ interface นั้น กรณี IP Tailnet ต่างกันยังไม่ถือว่าอยู่ LAN เดียวกัน

1. Deploy backend รุ่นนี้และสร้าง release ด้วย `node build-agent-release.js` ก่อน (ไฟล์ใน `releases/` ไม่เข้า Git)
2. หยุดหุ่นยนต์/มอเตอร์ให้ปลอดภัยและบันทึกงานก่อน การอัปเดตจะปิด Terminal/เครื่องมือ Online ของหุ่นยนต์นี้ทุกแท็บ รวมถึงผู้ใช้อื่น งานใน Terminal อาจถูกหยุด
3. ใน IDE หุ่นยนต์จริง กดปุ่ม `⇄` มุมบนขวา → **อัปเดต Agent** → ยืนยันเพียงครั้งเดียว ระบบปิดเครื่องมือและพักคำขอใหม่ให้ ไม่ต้องกดปิด Terminal แยก
4. ดู progress bar ตามขั้นตอน: เตรียม → ดาวน์โหลด → ตรวจไฟล์ → dependencies → restart → รอเชื่อมกลับ → **100% อัปเดตสำเร็จ** ระบบติดตามให้อัตโนมัติ กดซ้ำ/เปิดหน้าต่างใหม่จะติดตามงานเดิม ไม่เริ่มติดตั้งซ้ำ
5. บนเครื่องหุ่นยนต์อ่าน `~/.ros2ide/local-access.txt` เพื่อดู URL Local; ไม่มีรหัสจับคู่สำหรับผู้ใช้
6. Tablet/คอมพิวเตอร์ใน LAN กด “เริ่มภารกิจ” จากหน้า Cloud เพื่อเข้า Local อัตโนมัติ เครื่องที่เป็นตัวหุ่นยนต์เปิด Local URL ได้โดยตรง เครื่องอื่นที่เปิด Local URL โดยไม่มีสิทธิ์ครั้งเดียวจะเห็นลิงก์กลับ Cloud เพื่อยืนยันสิทธิ์
7. กลับ Online โดยปิดเครื่องมือ Local ก่อน แล้วเลือก **ใช้ ONLINE บนหน้านี้** จากหน้าต่าง `⇄` ฝั่ง Cloud

เปอร์เซ็นต์เป็นความคืบหน้าตามขั้นตอน ไม่ใช่เปอร์เซ็นต์จำนวนไบต์หรือเวลาที่เหลือ จะไม่ขึ้น 100% จากเพียงการรับคำขอ ต้องมีผลติดตั้งเสร็จและยืนยัน Agent รุ่นเป้าหมายเชื่อมกลับมาใหม่ด้วย หากล้มเหลวจะแสดงคำอธิบายและปุ่มลองอีกครั้ง งาน exec เดิมรอได้สูงสุด 90 วินาทีโดยไม่สั่ง kill; ถ้ายังทำงานอยู่จะไม่เริ่มติดตั้ง ส่วนเครื่องมือฝั่ง Local ต้องหยุดให้เรียบร้อยก่อนอัปเดตผ่าน Online

สถานะอัปเดตเก็บใน `tmp/agent-updates/` ฝั่ง Cloud (สิทธิ์ไฟล์ 0600) และ `~/.ros2ide/update-progress.json` ฝั่งหุ่นยนต์ ตัวติดตั้งรายงานผ่าน token เฉพาะงาน ไม่ส่ง token นี้ให้เบราว์เซอร์ สถานะยังติดตามต่อได้เมื่อปิด/เปิดหน้าใหม่หรือ PM2 restart ช่วงเตรียมที่ยังไม่เริ่ม installer จะรายงานให้ลองใหม่ ไม่ปล่อยค้าง

## ความปลอดภัยและพฤติกรรม

- เลือกเส้นทางด้วยคน ไม่มี automatic failover และไม่ replay คำสั่งหลัง reconnect
- เก็บโหมดที่เลือกบนหุ่นยนต์ เมื่อ Agent/reboot กลับมาจะยังเป็นโหมดเดิม แต่ไม่กู้คืนคำสั่ง/PTY ที่เคยรัน
- Agent เป็นผู้ตัดสิน Online/Local เพียงตัวเดียว ฝั่งที่ไม่ได้เลือกยังเชื่อมต่อและดู Agent status ได้ แต่ส่ง exec/files/PTY ไม่ได้
- ห้ามสลับขณะมี exec/file operation หรือ PTY ทำงาน ปิดงานให้เรียบร้อยก่อน แม้แต่ Terminal ว่างก็นับว่ากำลังเปิดอยู่
- Epoch ปฏิเสธ packet จากโหมดก่อนหน้า และ robot-issued ticket ปฏิเสธข้อมูล Tune/Mapping/Navigation ที่เก่ากว่า 1.5 วินาที โดยไม่อาศัยนาฬิกา Cloud ตรงกับหุ่นยนต์
- การ disconnect Cloud ปิดเฉพาะ PTY ของ Cloud ไม่ปิด Local PTY
- นี่ไม่ใช่ระบบ hard-real-time หรือ safety-certified E-stop ต้องใช้ watchdog/E-stop ที่ motor controller จริงด้วย และทดสอบล้อพ้นพื้นก่อนใช้งาน
- เปิด HTTP ค่าเริ่มต้นบนพอร์ต 3080 สำหรับ LAN ที่เชื่อถือได้เท่านั้น HTTP ไม่เข้ารหัสรหัสผ่านหรือข้อมูล ห้ามเปิดพอร์ตนี้สู่อินเทอร์เน็ต/เครือข่ายสาธารณะ
- เปลี่ยน `local_host` เป็น `127.0.0.1` ใน config ได้เพื่อจำกัดเฉพาะเครื่องเดียว; รุ่นนี้ยังไม่มีตัวช่วยติดตั้ง HTTPS/certificate อัตโนมัติ
- หากตั้ง TLS reverse proxy บนหุ่นยนต์เอง ให้ proxy ไป loopback, ตั้ง `local_host: "127.0.0.1"` และ `local_origin: "https://robot.example"` ให้ตรง URL จริง พร้อมส่ง Host/WebSocket upgrade ผ่าน proxy; certificate ต้องเป็นที่เชื่อถือของ tablet
- Local operator ที่เข้าผ่าน Cloud หรือเปิดเบราว์เซอร์บนเครื่องหุ่นยนต์มีสิทธิ์ใช้ shell/files ตามสิทธิ์ Linux user ที่รัน Agent ไม่ใช่ sandbox หรือระบบผู้ใช้หลายสิทธิ์ การเข้าผ่าน Cloud ใช้รหัส sudo ที่บันทึกไว้กับหุ่นและเก็บในหน่วยความจำ Local เท่านั้น; การเปิดตรงบนเครื่องหุ่นยนต์ขณะออฟไลน์ไม่มีรหัส sudo จาก Cloud
- Local token อายุ 12 ชั่วโมง ไม่อาศัยบัญชี/สมาชิก Cloud และหมดสภาพเมื่อ Local service รีสตาร์ต
- กัน cross-origin API/WS และ Host ที่ไม่ใช่เครื่องหุ่นยนต์ ไม่ส่ง token Cloud เข้า Local URL ([same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy))

## ไฟล์และคลังชิ้นส่วน

- Workspace จริงเป็นแหล่งข้อมูลหลักทั้งสองโหมด ไม่ทำ cloud mirror หรือ sync สองชุด
- เมื่อ Agent 2.1 เชื่อม Cloud จะรับ canonical workspace จากข้อมูลหุ่นยนต์มาเก็บใน config ให้ Local ใช้ path เดียวกัน หากเปลี่ยน workspace ใน Cloud ให้ reconnect Agent ก่อนใช้ Local
- Editor ส่ง content revision เมื่อบันทึก ถ้าไฟล์บนหุ่นยนต์เปลี่ยนไปจะรายงาน `FILE_CONFLICT` และไม่ทับไฟล์ ให้เก็บงานที่แก้ไว้แล้วโหลดไฟล์ใหม่
- Agent รุ่นเก่า/เครื่องมือสร้าง package ที่ไม่ได้ส่ง revision ยังใช้วิธีเดิม การป้องกัน revision ครอบคลุม Text Editor และคลังร่วม ไม่ใช่ transaction ครอบทุก shell command/package writer
- ในหน้าต่าง `⇄` มี **บันทึกคลังไปหุ่นยนต์ / โหลดคลังจากหุ่นยนต์** เป็นการ sync แบบผู้ใช้กดเอง ไม่ย้ายหรือทับ localStorage เดิมอัตโนมัติ
- การโหลดจะเก็บสำเนาคลังเบราว์เซอร์ไว้ก่อน การบันทึกตรวจ revision เพื่อไม่ทับคลังที่อีกแท็บเพิ่งเปลี่ยน

## ติดตั้งและอัปเดต

ต้องมี Node.js 20+, npm, curl, tar, flock และ systemd user session ใช้งานได้ Native `node-pty` อาจต้องมี compiler/build-essential/python3 ขึ้นกับเครื่อง

```bash
# รันบนหุ่นยนต์ที่หยุดงานแล้ว — ใช้ Cloud URL จริงของคุณ
curl -fsSL https://server-ubuntu-mechatronic.taile47ae6.ts.net:8443/install.sh | bash

# ตรวจสถานะและ log บนหุ่นยนต์
systemctl --user status ros2ide-agent
journalctl --user -u 'ros2ide-agent-update-*'
journalctl --user -u ros2ide-agent
```

- ติดตั้งครั้งแรก/ดาวน์โหลด dependency/อัปเดต/ติดตั้ง ROS driver ใหม่ ยังต้องมีอินเทอร์เน็ต หรือจัดเตรียม apt/npm cache แยกต่างหาก
- หลังติดตั้งแล้ว UI/Three.js/TransformControls/xterm อยู่ในหุ่นยนต์ครบ ใช้ system fonts แทน Google Fonts ไม่ต้องมี browser cache เดิม
- YouTube, Cloud chat, billing และบริการภายนอกไม่พร้อมใช้ offline
- Installer ดาวน์โหลดไป release directory ใหม่ ตรวจ SHA-256 และ `npm ci`/syntax/dependency ก่อนเปลี่ยน `current` symlink และ restart service
- เก็บ Robot Key, config fields, workspace, library, source Agent เก่าและ service เดิมไว้ ไม่ลบ release เก่าอัตโนมัติ
- หากตรวจ Local readiness หลัง restart ไม่ผ่าน จะคืน service เดิมและ symlink รุ่นก่อน (ถ้ามี) พร้อมเก็บ staging/log ให้ตรวจสอบ
- Remote update รันโดย systemd unit แยก จึงไม่ถูกตัดกลางทางเมื่อ Agent ถูก restart และไม่ถาม sudo ผ่านเว็บ
- URL ดาวน์โหลด/รายงานผลรักษา HTTPS ของหน้าเว็บหรือ PUBLIC_URL แม้อยู่หลัง reverse proxy แต่ละงานใช้ unit ID แยก และตรวจงานอัปเดตรุ่นเก่าที่กำลังรันก่อนเพื่อไม่เริ่มซ้ำ
- ไม่เปลี่ยน firewall, ไม่ apt upgrade, ไม่ลง/เปลี่ยน ROS distro และไม่แก้สิทธิ์ serial ในขั้นตอนอัปเดตนี้ ใช้ภารกิจ/เครื่องมือเตรียม serial เดิมตามความจำเป็น
- ถ้าใช้ CLI เก่าใน `/usr/local/bin` อยู่ ให้ใช้ `~/.local/bin/ros2ide-agent local` หรืออ่านไฟล์ local-access โดยตรง
- `.env`/DB dump/user uploads/Sim workspace ไม่ถูกบรรจุใน Agent release

## ตรวจสอบก่อนใช้งานจริง

```bash
npm test
node build-agent-release.js
# ใช้ stage path ที่ build แสดง เพื่อทดสอบ cold browser แบบบล็อกอินเทอร์เน็ต
ROSIDE_TEST_LOCAL_BUNDLE=/tmp/roside-release-XXXXXX node --test test/local-browser.test.js
```

ชุดทดสอบใช้ fake physical Agent, temporary workspace และ standalone Local broker ไม่สั่งมอเตอร์จริง การอัปเดต systemd/rollback บนหุ่นยนต์จริง การทดสอบ ESP32/serial, latency ภายใต้ Wi-Fi จริง และกรณีสายหลุดต้องยืนยันบน hardware ก่อนเปิดใช้ควบคุมจริง

การ deploy Cloud backend ต้อง restart PM2 เฉพาะ ros2-ide ในช่วงที่ไม่มีผู้ใช้/งานหุ่นยนต์หรือ Sim ทำงานอยู่ ไม่ควร restart ระหว่างใช้งานเพียงเพื่อให้ปุ่มใหม่ปรากฏ
