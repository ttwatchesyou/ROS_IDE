# ROSIDE — เตรียม SD Ubuntu 24.04 + ROS 2 Jazzy

เปิดจากหน้า /robots → ปุ่ม **โหลด Image / Flash SD** ข้าง **เพิ่มหุ่นยนต์จริง**
เครื่องมือนี้สร้างระบบใหม่สำหรับ Raspberry Pi 4/5 หรือ CM4/5 ARM64 ไม่โคลนหุ่นเดิม

1. ดาวน์โหลดและแตก ZIP บนคอมที่เสียบ SD ต้องมี Python 3.10+ บน Windows, macOS หรือ Linux
2. เปิด Start-ImageHelper.ps1 (PowerShell), Start-ImageHelper.command (macOS) หรือ Start-ImageHelper.sh (Linux) ด้วยคำสั่งที่หน้าเว็บแสดง ยอมรับ Administrator / sudo
3. ใช้ลิงก์ใน Terminal ซึ่งมี Token เฉพาะเครื่อง กดดาวน์โหลด Ubuntu ระบบตรวจ SHA256 จาก Ubuntu โดยตรงและเก็บไฟล์ไว้ใช้ซ้ำ
4. ตั้ง hostname, บัญชี Ubuntu/รหัสผ่าน, ROS Domain ID และ Wi-Fi (หรือใช้ LAN) เลือกติดตั้ง ROSIDE Agent พร้อม URL Cloud ได้
5. กดค้นหา SD เลือกการ์ด 32 GB ขึ้นไป พิมพ์รหัสดิสก์ยืนยัน แล้ว Flash ข้อมูลทั้งหมดบนการ์ดนั้นจะถูกลบ รอจนเขียนและอ่านกลับมาตรวจสอบครบ
6. ถอด SD อย่างปลอดภัย ใส่ Pi ต่ออินเทอร์เน็ตและเปิดเครื่อง รอประมาณ 20–60 นาที ระบบติดตั้ง Ubuntu Desktop, ROS 2 Jazzy, RViz2, Nav2, SLAM, Python, OpenCV, Git, SSH, net-tools (ifconfig), I²C และเครื่องมือพัฒนา แล้วรีบูต
7. ตรวจ /boot/firmware/ROSIDE.ENV ให้เป็น ready ดู log ด้วย sudo tail -f /var/log/roside-environment.log หากสะดุดใช้ sudo python3 /opt/roside-env/install_env.py เพื่อลองต่อ
8. หากเลือก Agent นำ Robot Key ใหม่ที่แสดงหลัง Flash ไปเพิ่มหุ่นจริงใน ROSIDE หากใช้ Tailscale ต้องติดตั้ง/ลงชื่อเข้าบัญชีบน Pi เอง

ไฟล์ Ubuntu ที่ดาวน์โหลดเป็นระบบตั้งต้น ROS และเครื่องมือติดตั้งบน Pi ครั้งแรก จึงต้องต่ออินเทอร์เน็ต ไม่ใช่ Image ROS ที่พร้อมใช้แบบ offline

Image ดาวน์โหลดโดยคอมจาก cdimage.ubuntu.com โดยตรง ROS/แพ็กเกจดาวน์โหลดบน Pi เซิร์ฟเวอร์ ROSIDE ให้เฉพาะ ZIP ขนาดเล็กและ Agent ไม่มีการอัปโหลดหรือ proxy ข้อมูล SD ผ่าน Cloud
Helper รับเฉพาะ loopback 127.0.0.1:3088 และ Token ไม่มี CORS สถานะ polling เฉพาะเครื่อง 2 วินาทีขณะทำงาน / 15 วินาทีเมื่อว่าง หยุดเมื่อซ่อนแท็บ

ต้องมีพื้นที่คอมพอเก็บไฟล์ .img.xz และแตก .img ชั่วคราว ไฟล์ฐานไม่ถูกแก้ แต่ละ SD สร้าง cloud-init instance และ Robot Key ใหม่ รหัสผ่าน Ubuntu แฮชก่อนใส่การ์ด รหัส Wi-Fi อยู่บนการ์ด เก็บ SD ให้ปลอดภัย
รองรับดิสก์ภายนอกที่ใช้ sector 512 bytes ระบบกีดกันดิสก์บูตและตรวจ fingerprint ก่อนเขียน การยกเลิกระหว่างเขียนทำให้ต้อง Flash ใหม่
