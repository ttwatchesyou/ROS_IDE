#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_BNO08x.h>

// ==========================================
// 0. KALMAN FILTER CLASS
// ==========================================
class SimpleKalmanFilter
{
public:
  SimpleKalmanFilter(float mea_e, float est_e, float q)
  {
    _err_measure = mea_e; _err_estimate = est_e; _q = q;
  }
  float updateEstimate(float mea)
  {
    _err_estimate += _q;
    _kalman_gain = _err_estimate / (_err_estimate + _err_measure);
    _current_estimate = _last_estimate + _kalman_gain * (mea - _last_estimate);
    _err_estimate = (1.0f - _kalman_gain) * _err_estimate;
    _last_estimate = _current_estimate;
    return _current_estimate;
  }
private:
  float _err_measure, _err_estimate, _q,
        _current_estimate = 0, _last_estimate = 0, _kalman_gain = 0;
};

// ==========================================
// 1. PIN DEFINITIONS
// ==========================================
#define FL_ENC_A PA0
#define FL_ENC_B PA1
#define FL_PWM   PA8
#define FL_DIR   PB12

#define FR_ENC_A PA3
#define FR_ENC_B PA2
#define FR_PWM   PB7
#define FR_DIR   PB13

#define RL_ENC_A PA4
#define RL_ENC_B PA5
#define RL_PWM   PB8
#define RL_DIR   PB14

#define RR_ENC_A PA7
#define RR_ENC_B PA6
#define RR_PWM   PB6
#define RR_DIR   PB15

#define ENC_X_A PB1
#define ENC_X_B PB0
#define ENC_Y_A PB9
#define ENC_Y_B PB5

#define IMU_RST PC13

// ==========================================
// 2. CONSTANTS
// ==========================================
const float TICKS_PER_REV_DRIVE      = 600.0f;
const float WHEEL_RADIUS_DRIVE       = 0.04f;
const float DEAD_WHEEL_TICKS_PER_REV = 600.0f;
const float DEAD_WHEEL_RADIUS        = 0.029f;
const float TICK_TO_DIST = (2.0f * PI * DEAD_WHEEL_RADIUS) / DEAD_WHEEL_TICKS_PER_REV;

const float ENC_X_OFFSET_Y = 0.0f;
const float ENC_Y_OFFSET_X = 0.0f;

const float MAX_ACCEL_XY  = 1.5f;    // m/s² — ramp XY (เพิ่มได้ถ้าอยากเร็วขึ้น)
// หมายเหตุ: MAX_ACCEL_ROT ถูกเอาออกไปแล้วเพราะ Yaw ใช้ PD ตรงๆ ไม่ผ่าน Ramp

// ==========================================
// 3. YAW PD PARAMETERS  (ปรับ runtime ผ่าน P id=5)
// ==========================================
float yaw_max_rpm   = 120.0f;
float yaw_min_rpm   = 15.0f;     // ชดเชยแรงเสียดทาน ให้หุ่นเข้าเป้าได้สนิท
float yaw_kp        = 80.0f;     // ยิ่งเยอะ หุ่นยิ่งตอบสนองไว/เบรกช้า
float yaw_kd        = 5.0f;      // ตัวหน่วงต้านแรงเฉื่อย (กัน Overshoot)
float prev_yaw_err  = 0.0f;
const float YAW_TOLERANCE = 0.02f; // Deadband ป้องกันหุ่นสั่นตอนเข้าเป้า

// ==========================================
// 4. DATA STRUCTURES
// ==========================================
struct MotorController
{
  float kp = 0.975f, ki = 5.005f, kd = 0.000f;
  float integral = 0.0f, prev_error = 0.0f;
  float target_rpm = 0.0f, current_rpm = 0.0f;
  volatile long ticks = 0;
  long prev_ticks = 0;
};
MotorController mFL, mFR, mRL, mRR;

struct PosPID
{
  float kp = 1.480f, ki = 0.0f, kd = 0.121f;
  float integral = 0.0f, prev_error = 0.0f;
  float output_limit = 0.6f;   // max speed (m/s) — ปรับผ่าน S command
} pidX, pidY;

// Pose
float curX = 0.0f, curY = 0.0f, curYaw = 0.0f;
float targetX = 0.0f, targetY = 0.0f, targetYaw = 0.0f;
float prev_yaw = 0.0f;

// Velocity state
float current_vx    = 0.0f;
float current_vy    = 0.0f;
float current_g_rpm = 0.0f;

// Manual mode
float manual_vx = 0.0f, manual_vy = 0.0f;
bool  is_manual_mode = false;

// Encoder ticks
volatile long tick_x = 0, tick_y = 0;
long prev_tick_x = 0, prev_tick_y = 0;

// IMU
Adafruit_BNO08x   bno08x(IMU_RST);
sh2_SensorValue_t sensorValue;
bool bno_ok = false;

TwoWire myWire(PB11, PB10);
unsigned long prev_time = 0;

// Kalman
SimpleKalmanFilter kFL(2.0f, 1.0f, 0.1f), kFR(2.0f, 1.0f, 0.1f),
                   kRL(2.0f, 1.0f, 0.1f), kRR(2.0f, 1.0f, 0.1f);

HardwareTimer *tim1, *tim4;
char serial_buf[64];
int  serial_idx = 0;

// ==========================================
// 5. INTERRUPTS
// ==========================================
void isr_fl()    { if (digitalRead(FL_ENC_B)) mFL.ticks++; else mFL.ticks--; }
void isr_fr()    { if (digitalRead(FR_ENC_B)) mFR.ticks++; else mFR.ticks--; }
void isr_rl()    { if (digitalRead(RL_ENC_B)) mRL.ticks++; else mRL.ticks--; }
void isr_rr()    { if (digitalRead(RR_ENC_B)) mRR.ticks++; else mRR.ticks--; }
void isr_enc_x() { if (digitalRead(ENC_X_B))  tick_x--;    else tick_x++;    }
void isr_enc_y() { if (digitalRead(ENC_Y_B))  tick_y++;    else tick_y--;    }

// ==========================================
// 6. FUNCTIONS
// ==========================================
void setMotor(int p_pwm, int p_dir, float val)
{
  int pwm = (int)fabs(val);
  if (pwm > 255) pwm = 255;
  if (pwm < 5)   pwm = 0;
  digitalWrite(p_dir, val >= 0 ? HIGH : LOW);
  if      (p_pwm == FL_PWM) tim1->setCaptureCompare(1, pwm, RESOLUTION_8B_COMPARE_FORMAT);
  else if (p_pwm == RR_PWM) tim4->setCaptureCompare(1, pwm, RESOLUTION_8B_COMPARE_FORMAT);
  else if (p_pwm == FR_PWM) tim4->setCaptureCompare(2, pwm, RESOLUTION_8B_COMPARE_FORMAT);
  else if (p_pwm == RL_PWM) tim4->setCaptureCompare(3, pwm, RESOLUTION_8B_COMPARE_FORMAT);
}

float applyRamp(float current, float target, float accel, float dt)
{
  float max_change = accel * dt;
  float diff = target - current;
  if (diff >  max_change) return current + max_change;
  if (diff < -max_change) return current - max_change;
  return target;
}

// ── Position PID ─────────────────────────────────────────────
float computePosPID(PosPID &p, float error, float dt)
{
  p.integral += error * dt;
  p.integral = constrain(p.integral, -p.output_limit, p.output_limit);
  float derivative = (error - p.prev_error) / dt;
  p.prev_error = error;
  float out = (p.kp * error) + (p.ki * p.integral) + (p.kd * derivative);
  return constrain(out, -p.output_limit, p.output_limit);
}

// ── Yaw PD Control (แทนที่ Profile เก่า) ──────────────────────
float computeYawPD(float target, float current, float dt)
{
  float error = target - current;
  while (error >  PI) error -= 2.0f * PI;
  while (error < -PI) error += 2.0f * PI;

  // 1. ถ้าระยะห่างน้อยกว่าที่ตั้งไว้ ให้หยุดทันที
  if (fabs(error) <= YAW_TOLERANCE) {
    prev_yaw_err = error;
    return 0.0f;
  }

  // 2. คำนวณความเร็วการเปลี่ยนแปลง (Derivative)
  float derivative = (error - prev_yaw_err) / dt;
  prev_yaw_err = error;

  // 3. สมการ PD Controller
  float output = (yaw_kp * error) + (yaw_kd * derivative);

  // 4. ชดเชยแรงเสียดทานขั้นต่ำ (Friction Compensation)
  if (output > 0.0f) output += yaw_min_rpm;
  if (output < 0.0f) output -= yaw_min_rpm;

  // 5. จำกัดความเร็วไม่ให้เกิน Max RPM
  return constrain(output, -yaw_max_rpm, yaw_max_rpm);
}

// ── Motor Velocity PID ───────────────────────────────────────
float computeVelPID(MotorController &m, float target, float dt)
{
  if (target == 0.0f && fabs(m.current_rpm) < 1.0f) { m.integral = 0; return 0; }
  float error = target - m.current_rpm;
  m.integral += error * dt;
  m.integral = constrain(m.integral, -250, 250);
  float derivative = (error - m.prev_error) / dt;
  m.prev_error = error;
  return (m.kp * error) + (m.ki * m.integral) + (m.kd * derivative);
}

// ==========================================
// 7. COMMAND PROCESSOR
// ==========================================
void processCommand(char *cmd_str)
{
  String data = String(cmd_str + 1);
  char   type = cmd_str[0];

  // G : Goal position (x:y:yaw)
  if (type == 'G')
  {
    int c1 = data.indexOf(':');
    int c2 = data.indexOf(':', c1 + 1);
    if (c1 != -1 && c2 != -1)
    {
      targetX        = data.substring(0, c1).toFloat();
      targetY        = data.substring(c1 + 1, c2).toFloat();
      targetYaw      = data.substring(c2 + 1).toFloat();
      is_manual_mode = false;
    }
  }
  // V : Manual velocity (vx:vy)
  else if (type == 'V')
  {
    int c1 = data.indexOf(':');
    if (c1 != -1)
    {
      manual_vx = data.substring(0, c1).toFloat();
      manual_vy = data.substring(c1 + 1).toFloat();
      if (!is_manual_mode)
      {
        targetYaw      = curYaw;
        is_manual_mode = true;
      }
    }
  }
  // Z : Reset odometry
  else if (type == 'Z')
  {
    curX = 0.0f; curY = 0.0f;
    tick_x = 0;  tick_y = 0;
    prev_tick_x = 0; prev_tick_y = 0;
    prev_yaw = curYaw;
    targetX = 0.0f; targetY = 0.0f; targetYaw = curYaw;
    current_vx = 0.0f; current_vy = 0.0f; current_g_rpm = 0.0f;
    manual_vx  = 0.0f; manual_vy  = 0.0f;
    pidX.integral = 0.0f; pidX.prev_error = 0.0f;
    pidY.integral = 0.0f; pidY.prev_error = 0.0f;
  }
  // S : Set max speed (m/s)
  else if (type == 'S')
  {
    int c1 = data.indexOf(':');
    float spd = (c1 != -1) ? data.substring(0, c1).toFloat()
                            : data.toFloat();
    if (spd > 0.0f) pidX.output_limit = pidY.output_limit = spd;
  }
  // P : Gains
  // id=5 → Yaw PD Parameter   P5:<max_rpm>:<kp>:<kd>
  // id=6 → Position PID       P6:<kp>:<ki>:<kd>
  else if (type == 'P')
  {
    int c1 = data.indexOf(':');
    int c2 = data.indexOf(':', c1 + 1);
    int c3 = data.indexOf(':', c2 + 1);
    if (c1 != -1 && c2 != -1 && c3 != -1)
    {
      int   id = data.substring(0, c1).toInt();
      float p  = data.substring(c1 + 1, c2).toFloat();
      float i  = data.substring(c2 + 1, c3).toFloat();
      float d  = data.substring(c3 + 1).toFloat();
      if (id == 5)
      {
        if (p > 0.0f) yaw_max_rpm = p;
        if (i > 0.0f) yaw_kp      = i;
        if (d > 0.0f) yaw_kd      = d;
      }
      else if (id == 6) // สำหรับจูนแกน X (เดินหน้า-ถอยหลัง)
      {
        pidX.kp = p; pidX.ki = i; pidX.kd = d;
      }
      else if (id == 7) // สำหรับจูนแกน Y (สไลด์ซ้าย-ขวา)
      {
        pidY.kp = p; pidY.ki = i; pidY.kd = d;
      }
      
      
     /*
      else if (id == 6)
      {
        pidX.kp = pidY.kp = p;
        pidX.ki = pidY.ki = i;
        pidX.kd = pidY.kd = d;
      }
      */
    }
  }
}

// ==========================================
// 8. SETUP
// ==========================================
void setup()
{
  delay(1000);

  Serial.begin(115200);

  pinMode(FL_DIR, OUTPUT); pinMode(FR_DIR, OUTPUT);
  pinMode(RL_DIR, OUTPUT); pinMode(RR_DIR, OUTPUT);

  pinMode(FL_ENC_A, INPUT_PULLUP); pinMode(FL_ENC_B, INPUT_PULLUP);
  pinMode(FR_ENC_A, INPUT_PULLUP); pinMode(FR_ENC_B, INPUT_PULLUP);
  pinMode(RL_ENC_A, INPUT_PULLUP); pinMode(RL_ENC_B, INPUT_PULLUP);
  pinMode(RR_ENC_A, INPUT_PULLUP); pinMode(RR_ENC_B, INPUT_PULLUP);
  pinMode(ENC_X_A,  INPUT_PULLUP); pinMode(ENC_X_B,  INPUT_PULLUP);
  pinMode(ENC_Y_A,  INPUT_PULLUP); pinMode(ENC_Y_B,  INPUT_PULLUP);

  tim1 = new HardwareTimer(TIM1);
  tim1->setMode(1, TIMER_OUTPUT_COMPARE_PWM1, FL_PWM);
  tim1->setOverflow(20000, HERTZ_FORMAT);
  tim1->resume();

  tim4 = new HardwareTimer(TIM4);
  tim4->setMode(1, TIMER_OUTPUT_COMPARE_PWM1, RR_PWM);
  tim4->setMode(2, TIMER_OUTPUT_COMPARE_PWM1, FR_PWM);
  tim4->setMode(3, TIMER_OUTPUT_COMPARE_PWM1, RL_PWM);
  tim4->setOverflow(20000, HERTZ_FORMAT);
  tim4->resume();

  attachInterrupt(digitalPinToInterrupt(FL_ENC_A), isr_fl,    RISING);
  attachInterrupt(digitalPinToInterrupt(FR_ENC_A), isr_fr,    RISING);
  attachInterrupt(digitalPinToInterrupt(RL_ENC_A), isr_rl,    RISING);
  attachInterrupt(digitalPinToInterrupt(RR_ENC_A), isr_rr,    RISING);
  attachInterrupt(digitalPinToInterrupt(ENC_X_A),  isr_enc_x, RISING);
  attachInterrupt(digitalPinToInterrupt(ENC_Y_A),  isr_enc_y, RISING);

  myWire.begin();
  myWire.setClock(100000);

  bno08x.hardwareReset();
  delay(100);

  int retries = 20;
  while (retries > 0)
  {
    if      (bno08x.begin_I2C(BNO08x_I2CADDR_DEFAULT,     &myWire)) { bno_ok = true; break; }
    else if (bno08x.begin_I2C(BNO08x_I2CADDR_DEFAULT + 1, &myWire)) { bno_ok = true; break; }
    else { Serial.println("BNO08x not found..."); bno08x.hardwareReset(); }
    delay(1000); retries--;
  }
  if (bno_ok) bno08x.enableReport(SH2_GAME_ROTATION_VECTOR, 10000);
}

// ==========================================
// 9. LOOP
// ==========================================
void loop()
{
  // Serial receive
  while (Serial.available())
  {
    char c = Serial.read();
    if (c == '\n') { serial_buf[serial_idx] = 0; processCommand(serial_buf); serial_idx = 0; }
    else if (serial_idx < 63) serial_buf[serial_idx++] = c;
  }

  // IMU update
  if (bno_ok)
  {
    while (bno08x.getSensorEvent(&sensorValue))
    {
      if (sensorValue.sensorId == SH2_GAME_ROTATION_VECTOR)
      {
        float r = sensorValue.un.gameRotationVector.real;
        float i = sensorValue.un.gameRotationVector.i;
        float j = sensorValue.un.gameRotationVector.j;
        float k = sensorValue.un.gameRotationVector.k;
        curYaw = atan2(2.0f * (r * k + i * j), 1.0f - 2.0f * (j * j + k * k));
      }
    }
  }

  // Main loop @ 50 Hz
  unsigned long now = millis();
  if (now - prev_time >= 20)
  {
    float dt = (now - prev_time) / 1000.0f;
    prev_time = now;

    // ─────────────────────────────────────
    // 1. ODOMETRY
    // ─────────────────────────────────────
    long d_tick_x = tick_x - prev_tick_x;
    long d_tick_y = tick_y - prev_tick_y;
    prev_tick_x = tick_x;
    prev_tick_y = tick_y;

    float delta_yaw = curYaw - prev_yaw;
    while (delta_yaw >  PI) delta_yaw -= 2.0f * PI;
    while (delta_yaw < -PI) delta_yaw += 2.0f * PI;
    prev_yaw = curYaw;

    float raw_dx  = d_tick_x * TICK_TO_DIST;
    float raw_dy  = d_tick_y * TICK_TO_DIST;
    float true_dx = raw_dx - (ENC_X_OFFSET_Y * delta_yaw);
    float true_dy = raw_dy + (ENC_Y_OFFSET_X * delta_yaw);

    curX += true_dx * cos(curYaw) - true_dy * sin(curYaw);
    curY += true_dx * sin(curYaw) + true_dy * cos(curYaw);

    // ─────────────────────────────────────
    // 2. INPUT STRATEGY
    // ─────────────────────────────────────
    float raw_vx = 0.0f, raw_vy = 0.0f;

    float errYaw = targetYaw - curYaw;
    while (errYaw >  PI) errYaw -= 2.0f * PI;
    while (errYaw < -PI) errYaw += 2.0f * PI;

    if (is_manual_mode)
    {
      raw_vx = manual_vx;
      raw_vy = manual_vy;
    }
    else
    {
      float errX_global = targetX - curX;
      float errY_global = targetY - curY;
      float errX_robot  =  errX_global * cos(curYaw) + errY_global * sin(curYaw);
      float errY_robot  = -errX_global * sin(curYaw) + errY_global * cos(curYaw);

      raw_vx = computePosPID(pidX, errX_robot, dt);
      raw_vy = computePosPID(pidY, errY_robot, dt);
    }

    // ─────────────────────────────────────
    // 3. YAW PD + KINEMATICS
    // ─────────────────────────────────────
    // โยนสมการ Ramp ของ Yaw ทิ้งไปเลย ให้ PD ส่งคำสั่งสับความเร็วมอเตอร์ตรงๆ
    current_g_rpm = computeYawPD(targetYaw, curYaw, dt);

    // X, Y ยังคงมี Ramp เพื่อความนุ่มนวล
    current_vx    = applyRamp(current_vx,    raw_vx,    MAX_ACCEL_XY,  dt);
    current_vy    = applyRamp(current_vy,    raw_vy,    MAX_ACCEL_XY,  dt);

    float to_rpm = 60.0f / (2.0f * PI * WHEEL_RADIUS_DRIVE);
    float rpm_vx = current_vx * to_rpm;
    float rpm_vy = current_vy * to_rpm;

    mFL.target_rpm = rpm_vx - rpm_vy - current_g_rpm;
    mFR.target_rpm = rpm_vx + rpm_vy + current_g_rpm;
    mRL.target_rpm = rpm_vx + rpm_vy - current_g_rpm;
    mRR.target_rpm = rpm_vx - rpm_vy + current_g_rpm;

    // --- Normalization ---
    float MOTOR_MAX_RPM = 300.0f; 
    
    float max_rpm = fabs(mFL.target_rpm);
    if (fabs(mFR.target_rpm) > max_rpm) max_rpm = fabs(mFR.target_rpm);
    if (fabs(mRL.target_rpm) > max_rpm) max_rpm = fabs(mRL.target_rpm);
    if (fabs(mRR.target_rpm) > max_rpm) max_rpm = fabs(mRR.target_rpm);

    if (max_rpm > MOTOR_MAX_RPM) {
        float scale = MOTOR_MAX_RPM / max_rpm;
        mFL.target_rpm *= scale;
        mFR.target_rpm *= scale;
        mRL.target_rpm *= scale;
        mRR.target_rpm *= scale;
    }

    // ─────────────────────────────────────
    // 4. MOTOR VELOCITY PID
    // ─────────────────────────────────────
    float rpm_k = 60.0f / (TICKS_PER_REV_DRIVE * dt);

    mFL.current_rpm = kFL.updateEstimate((mFL.ticks - mFL.prev_ticks) * rpm_k); mFL.prev_ticks = mFL.ticks;
    mFR.current_rpm = kFR.updateEstimate((mFR.ticks - mFR.prev_ticks) * rpm_k); mFR.prev_ticks = mFR.ticks;
    mRL.current_rpm = kRL.updateEstimate((mRL.ticks - mRL.prev_ticks) * rpm_k); mRL.prev_ticks = mRL.ticks;
    mRR.current_rpm = kRR.updateEstimate((mRR.ticks - mRR.prev_ticks) * rpm_k); mRR.prev_ticks = mRR.ticks;

    float pwm_FL = computeVelPID(mFL, mFL.target_rpm, dt);
    float pwm_FR = computeVelPID(mFR, mFR.target_rpm, dt) * -1.0f;
    float pwm_RL = computeVelPID(mRL, mRL.target_rpm, dt);
    float pwm_RR = computeVelPID(mRR, mRR.target_rpm, dt) * -1.0f;

    setMotor(FL_PWM, FL_DIR,  pwm_FL);
    setMotor(FR_PWM, FR_DIR,  pwm_FR);
    setMotor(RL_PWM, RL_DIR,  pwm_RL);
    setMotor(RR_PWM, RR_DIR,  pwm_RR);

    // ─────────────────────────────────────
    // 5. SERIAL OUTPUT → ROS
    // ─────────────────────────────────────
    Serial.print("POS:");
    Serial.print(curX,   3); Serial.print(":");
    Serial.print(curY,   3); Serial.print(":");
    Serial.print(curYaw, 3); Serial.print(":");
    Serial.print(tick_x);   Serial.print(":");
    Serial.println(tick_y);
  }
}