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
export ADMIN_PASSWORD='replace-with-at-least-12-characters'

npm run setup
npm start
```

เปิด `http://localhost:3000` แล้วเพิ่ม robot จากหน้า Robots เครื่องหุ่นยนต์ติดตั้ง agent ด้วยคำสั่งที่หน้าเว็บสร้างให้

## Environment ที่สำคัญ

- `PORT` — HTTP port, ค่าเริ่มต้น `3000`
- `PUBLIC_URL` — public URL เมื่ออยู่หลัง reverse proxy
- `CORS_ORIGINS` — origins ที่อนุญาต คั่นด้วย comma; ว่างหมายถึง same deployment/dev mode
- `ALLOW_REGISTRATION=true` — เปิด self-registration; ค่าเริ่มต้นปิด
- `ALLOW_UNSANDBOXED_SIM=true` — อนุญาต user ทั่วไปรัน simulation บน host โดยตรง
- `JSON_LIMIT` — request body limit, ค่าเริ่มต้น `10mb`
- `TRUST_PROXY=true` — ใช้เมื่อ deploy หลัง reverse proxy ที่เชื่อถือได้ เพื่ออ่าน client IP สำหรับ rate limit

## ข้อควรระวังด้าน simulation

Simulation สามารถ compile และรันโค้ดของผู้เรียนได้ จึงเทียบเท่าการให้สิทธิ์ shell ใน runtime นั้น ค่าเริ่มต้นอนุญาตเฉพาะ admin จนกว่าจะมี isolated runtime เช่น container/VM ต่อผู้ใช้ ห้ามเปิด `ALLOW_UNSANDBOXED_SIM` บน public server ที่มีผู้ใช้ที่ไม่ไว้วางใจ

## ตรวจสอบ

```bash
npm test
npm audit --omit=dev
```

ไฟล์ runtime ใน `sim_ws/`, `build/`, `install/` และ `log/` ไม่ใช่ source code และไม่ควร commit
