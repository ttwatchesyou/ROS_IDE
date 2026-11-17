# Mecanum 4 ล้อ + Encoder X/Y

## ใช้งาน

1. เปิด Robot Model โหมด 3D → Template → **Mecanum 4 ล้อ + Encoder X/Y**
2. ตรวจระยะศูนย์ล้อจริง แล้วบันทึก TF / ODOM / Model
3. เปิด **Hardware Wiring Workspace** จะเลือก STM32F103 + PWM/DIR และ BNO08x ให้
4. ตรวจผังสาย กดสร้างโค้ด แล้วดู `main.cpp`, `platformio.ini`, `controller_bridge.py` และ README ก่อน Build/Upload

โมเดลมีล้อขับ mecanum 4 ล้อ ขนาด 127 mm, พักการวัด Encoder ความเร็วล้อทั้ง 4 ตัว และใช้ Encoder วัดระยะ X/Y อิสระอีก 2 ตัว พร้อมล้อวัดระยะรัศมี 29 mm ล้อวัดระยะไม่ถูกนับเป็นมอเตอร์

ตัวถัง 660 × 662 mm ตามตัวอย่าง; ตำแหน่งศูนย์ล้อขับเริ่มต้น X=±300 mm, Y=±360 mm เป็นค่าเริ่มต้นสำหรับโมเดล ต้องปรับตามหุ่นจริงก่อนสร้าง firmware

## ผังสาย

| อุปกรณ์ | PWM | DIR | Encoder A | Encoder B |
|---|---|---|---|---|
| FL | PA8 | PB12 | PA0 | PA1 |
| FR | PB6 | PB15 | PA2 | PA3 |
| RL | PB7 | PB13 | PA4 | PA5 |
| RR | PB8 | PB14 | PA6 | PA7 |
| Passive X | — | — | PB0 | PB1 |
| Passive Y | — | — | PB9 | PB5 |

ขา PA0–PA7 อ่าน Encoder มอเตอร์แยกทั้ง 4 ล้อเพื่อแสดงพัลส์และ RPM ในหน้าควบคุมมอเตอร์แยกตัว โดยแยกจากการควบคุมความเร็วและ ODOM มอเตอร์ยังใช้ PWM feed-forward โดย FR/RR กลับทิศตามล้อขวาของหุ่นจริง ขา interrupt เลือก A หรือ B เพื่อหลบ EXTI ของ Encoder X/Y; หากพินชนจะรายงานว่าไม่ได้อ่านขานั้น

ค่าเริ่มต้น Passive X ใช้ PB0/PB1 และ Passive Y ใช้ PB9/PB5; ใน Hardware Wiring เลือก “สลับ X ↔ Y” เพื่อให้ X ใช้ PB9/PB5 และ Y ใช้ PB0/PB1 โดยไม่ต้องสลับสาย แล้วสร้างและ Upload Firmware ใหม่ โดยนับขอบ RISING แบบ ×1 ที่ 600 ticks/revolution (ค่าเริ่มต้น) Encoder X/Y ทั้งคู่ยังจำเป็นสำหรับ ODOM และ Position Control

BNO08x: SCL PB10, SDA PB11, RESET PC13, 3V3 และ GND ร่วม
USART1: PA9 TX, PA10 RX, 115200 baud เริ่มต้น

## Position control

ใช้ position controller, filtering, heading estimator, feed-forward และ timeout จาก `codebackupmicronw/mechanum-withencodrxy` ปรับ geometry เป็น mecanum ล้อขนาน ลูกกลิ้งรูป X Speed PID ของล้อขับไม่ทำงานในโปรไฟล์นี้ โดยแยก RPM ที่อ่านเพื่อตรวจสอบออกจากวงควบคุม

Encoder ตำแหน่ง X/Y **ต้องเปิดทั้งคู่** และ BNO08x ต้องส่งมุมหัวหุ่นสดต่อเนื่อง: Encoder วัดระยะสองแกนเพียงอย่างเดียวแยกการเลื่อนออกจากการหมุนไม่ได้ หาก IMU ขาดข้อมูล position control จะหยุด มอเตอร์ feed-forward อาจวิ่งไม่ตรงกับความเร็วที่สั่งจริง จึงต้องตรวจทิศและทดสอบบนพื้นที่โล่ง

- `/cmd_vel`: รองรับ linear.x, linear.y และ angular.z; ยกเลิก position mode
- `/controller/position_goal`: `std_msgs/msg/Float32MultiArray`, `[x_m, y_m, yaw_rad]` ใน world frame
- `/controller/position_keepalive`: `std_msgs/msg/Empty`, ส่งถี่กว่า timeout ระหว่างควบคุมตำแหน่ง
- `/controller/stop`: `std_msgs/msg/Empty`, หยุดมอเตอร์
- `/odom`: ตำแหน่งจาก passive X/Y และ heading
- `/controller/reset_odometry`: reset pose

ส่ง goal หนึ่งครั้ง แล้วส่ง keepalive ระหว่างกำกับการเคลื่อนที่ ไม่มี automatic keepalive เพื่อให้ timeout หยุดหุ่นเมื่อ client ขาดการติดต่อ ค่าเริ่มต้น timeout 1000 ms และ position speed 0.35 m/s

รายละเอียดคำสั่ง serial และการสร้าง ROS package อยู่ใน README ที่ Hardware Workspace สร้างให้

## Robot Tune และแดชบอร์ด ODOM

Firmware ที่ Generate ใหม่ส่ง `ROSIDE_CONTROLLER_READY`, `ODOM x y yaw vx vy wz` และ `GYRO gx gy gz` เมื่อ BNO08x มีข้อมูลจริง เพิ่มเฟรม `WENC ticks_fl rpm_fl ticks_fr rpm_fr ticks_rl rpm_rl ticks_rr rpm_rr enabled_mask` ทุกประมาณ 100 ms สำหรับหน้าควบคุมมอเตอร์แยกตัว โดย mask แต่ละบิตระบุล้อที่อ่านได้ (FL/FR/RL/RR) และพัลส์เริ่มใหม่เมื่อบอร์ดรีบูต ต้องสร้างและ Upload Firmware ใหม่ก่อนจึงจะได้รับข้อมูลนี้ หน้า Robot Tune ใช้ ODOM ยืนยันการเชื่อมต่อ แสดงตาราง X/Y เป็นเมตร, yaw เป็นองศา, ระยะทางและมุมหมุนสะสมของการเชื่อมต่อปัจจุบัน สามารถเลือกสัญญาณ ODOM ลงกราฟเวลา และกด `＋ แผนที่ X/Y` เพื่อดูเส้นทาง 2 มิติ ลากเลื่อนและซูมด้วยเมาส์ได้

หลังอัปเดต Agent ให้สร้าง Config/Firmware ใหม่ใน Hardware Wiring แล้ว Build และ Upload ลง STM32 ก่อนเปิด Robot Tune


Firmware รุ่นตรวจสัญญาณเพิ่ม `WDIAG a_mask b_mask irq_ready_mask edges_fl edges_fr edges_rl edges_rr` ประมาณทุก 500 ms โดย A/B คือระดับลอจิกขณะอ่าน ไม่ใช่แรงดันที่วัดด้วย ADC; ขอบสัญญาณคือจำนวนครั้งที่ ISR ทำงานแยกจากพัลส์มีเครื่องหมาย หน้า Motor Control จับคู่บิตและค่าแต่ละตัวตาม FL/FR/RL/RR และซ่อนข้อมูลที่ค้างเกิน 2 วินาที Interrupt ของล้อเปิดหลังเริ่ม IMU และตรวจ AFIO/EXTI/NVIC เฉพาะเส้นที่ไม่ชนอุปกรณ์อื่น การตรวจนี้ไม่ยืนยันว่ามีสัญญาณจากสายหรือเซนเซอร์จริง ต้องหมุนล้อและสังเกตค่า A/B กับขอบสัญญาณหลัง Upload
