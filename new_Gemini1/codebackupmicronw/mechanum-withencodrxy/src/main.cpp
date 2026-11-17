#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_BNO08x.h>
#include "wheel_config.h"
#include "drive_geometry.h"
#include "omni_kinematics.h"
#include "open_loop_speed.h"
#include "speed_ramp.h"
#include "odom_filter.h"
#include "position_profile.h"
#include "yaw_profiles.h"
#include "heading_estimator.h"

// Use USART1 explicitly. The USB-to-TTL adapter is wired to PA10 (RX) and
// PA9 (TX), rather than relying on the default Serial object mapping.
#define tunerSerial Serial1

struct Pid {
  // Validated unloaded from 50 through 400 RPM. The 500-RPM command is
  // available for measurement, but its gains have not been validated.
  // Runtime PID commands can
  // override the automatic per-speed preset for an experiment.
  float kp = 0.8f;
  float ki = 0.35f;
  float kd = 0.0f;
  float integral = 0.0f;
  float previous_error = 0.0f;
};

// ── BNO08x yaw hold ───────────────────────────────────────────────────
// Wiring follows the supplied previous-robot firmware: SCL=PB10, SDA=PB11,
// reset=PC13.  Robot frame is +yaw counter-clockwise.  Set this true only if
// a physical CCW rotation makes the reported yaw decrease.
constexpr uint32_t IMU_SDA_PIN = PB11;
constexpr uint32_t IMU_SCL_PIN = PB10;
constexpr uint32_t IMU_RESET_PIN = PC13;
constexpr bool IMU_YAW_INVERTED = false;
// XY floor trials, loaded robot, 2026-09-24: heading stayed within 2.7 deg
// during +/-0.8 m moves at a 0.35 m/s command. Faster motion is not validated.
float yaw_hold_kp = 9.5f;                      // rad/s per rad of heading error
float yaw_hold_kd = 0.40f;                      // damping against yaw-rate estimate
float yaw_hold_max_wz_radps = 1.50f;
bool yaw_profile_active = false; // Manual PID behavior remains the default.
constexpr float YAW_HOLD_TOLERANCE_RAD = 0.015f; // ~0.9 degrees
constexpr float YAW_COMMAND_DEADBAND_RADPS = 0.02f;
// Loaded chassis needs about 0.2 rad/s before all four wheels break static
// friction.  A small margin avoids the multi-second crawl seen near target;
// this is applied only after the measured yaw has stalled.
constexpr float YAW_MIN_EFFECTIVE_WZ_RADPS = 0.25f;
constexpr float YAW_STALL_RATE_RADPS = 0.03f;
constexpr float YAW_STALL_CONFIRM_SEC = 0.15f;

TwoWire imuWire(IMU_SDA_PIN, IMU_SCL_PIN);
Adafruit_BNO08x bno08x(IMU_RESET_PIN);
sh2_SensorValue_t imu_event;
bool imu_ok = false;
bool yaw_hold_enabled = true;
bool yaw_target_latched = false;
float imu_yaw_rad = 0.0f;
float sensor_yaw_rad = 0.0f;
bool heading_available = true;
unsigned long last_imu_update_ms = 0;
float yaw_target_rad = 0.0f;
float previous_yaw_error = 0.0f;
float yaw_correction_wz = 0.0f;
float yaw_stall_seconds = 0.0f;

float wrapAngle(float radians) {
  radians = fmodf(radians, 2.0f * PI);
  if (radians > PI) radians -= 2.0f * PI;
  if (radians < -PI) radians += 2.0f * PI;
  return radians;
}

void updateImuYaw() {
  if (!imu_ok) return;
  while (bno08x.getSensorEvent(&imu_event)) {
    if (imu_event.sensorId != SH2_GAME_ROTATION_VECTOR) continue;
    const float real = imu_event.un.gameRotationVector.real;
    const float i = imu_event.un.gameRotationVector.i;
    const float j = imu_event.un.gameRotationVector.j;
    const float k = imu_event.un.gameRotationVector.k;
    float yaw = atan2f(2.0f * (real * k + i * j),
                       1.0f - 2.0f * (j * j + k * k));
    if (!isfinite(yaw)) continue;
    sensor_yaw_rad = IMU_YAW_INVERTED ? -yaw : yaw;
    last_imu_update_ms = millis();
  }
}

void scanI2cBus() {
  uint8_t found = 0;
  tunerSerial.println("T:I2C:SCAN_BEGIN");
  for (uint8_t address = 1; address < 127; ++address) {
    imuWire.beginTransmission(address);
    if (imuWire.endTransmission() != 0) continue;
    tunerSerial.print("T:I2C:FOUND:0x");
    if (address < 16) tunerSerial.print('0');
    tunerSerial.println(address, HEX);
    ++found;
  }
  tunerSerial.print("T:I2C:SCAN_DONE:");
  tunerSerial.println(found);
}

bool beginImuAt(uint8_t address) {
  // Adafruit BusIO calls begin() itself. Deinitialise the STM32 peripheral
  // first so every attempt starts from a complete end/begin cycle.
  imuWire.end();
  tunerSerial.print("T:IMU:ADDRESS:0x");
  tunerSerial.println(address, HEX);
  if (bno08x.begin_I2C(address, &imuWire)) return true;
  tunerSerial.print("T:IMU:FAIL:");
  tunerSerial.print(bno08x.initStage);
  tunerSerial.print(':');
  tunerSerial.println(bno08x.initStatus);
  return false;
}

bool initialiseImu() {
  imuWire.begin();
  // The supplied previous firmware used 100 kHz.  It is more tolerant of the
  // long jumper wiring normally used with this BNO08x module than 400 kHz.
  imuWire.setClock(100000);
  bno08x.hardwareReset();
  // Allow startup to settle. Manual T:I2C_SCAN remains available separately.
  delay(500);

  // Retry flow retained from the supplied previous-robot firmware.  Try both
  // standard BNO08x I2C addresses, reset the sensor after a failed pair, then
  // give its firmware one second to boot before retrying.
  bool bno_ok = false;
  int retries = 20;
  while (retries > 0) {
    const int attempt = 21 - retries;
    tunerSerial.print("T:IMU:INIT_ATTEMPT:");
    tunerSerial.println(attempt);

    if (beginImuAt(BNO08x_I2CADDR_DEFAULT)) {
      bno_ok = true;
      break;
    } else if (beginImuAt(BNO08x_I2CADDR_DEFAULT + 1)) {
      bno_ok = true;
      break;
    } else {
      tunerSerial.println("T:IMU:NOT_FOUND:RESET");
      bno08x.hardwareReset();
    }
    delay(1000);
    --retries;
  }

  if (!bno_ok) return false;
  tunerSerial.print("T:IMU:PRODUCT:");
  tunerSerial.println(bno08x.prodIds.entry[0].swPartNumber);
  if (!bno08x.enableReport(SH2_GAME_ROTATION_VECTOR, 10000)) {
    tunerSerial.println("T:WARN:IMU_REPORT_ENABLE_FAILED");
    return false;
  }
  // READY requires a real quaternion, not just a successful feature command.
  const uint32_t started = millis();
  while (millis() - started < 2000) {
    if (bno08x.getSensorEvent(&imu_event) &&
        imu_event.sensorId == SH2_GAME_ROTATION_VECTOR) {
      const auto &q = imu_event.un.gameRotationVector;
      const float yaw = atan2f(2.0f * (q.real * q.k + q.i * q.j),
                              1.0f - 2.0f * (q.j * q.j + q.k * q.k));
      if (!isfinite(yaw)) continue;
      imu_yaw_rad = IMU_YAW_INVERTED ? -yaw : yaw;
      sensor_yaw_rad = imu_yaw_rad;
      last_imu_update_ms = millis();
      return true;
    }
    delay(1);
  }
  tunerSerial.println("T:IMU:FAIL:NO_ROTATION_REPORT");
  return false;
}

float computeYawHold(float commanded_wz, float dt) {
  if (!heading_available || !yaw_hold_enabled) return commanded_wz;

  // A deliberate turn takes priority.  On releasing the turn command the
  // current orientation is latched as the new heading to preserve.
  if (fabsf(commanded_wz) > YAW_COMMAND_DEADBAND_RADPS) {
    yaw_target_rad = imu_yaw_rad;
    yaw_target_latched = false;
    previous_yaw_error = 0.0f;
    yaw_correction_wz = 0.0f;
    return commanded_wz;
  }
  if (!yaw_target_latched) {
    yaw_target_rad = imu_yaw_rad;
    yaw_target_latched = true;
    previous_yaw_error = 0.0f;
  }
  const float error = wrapAngle(yaw_target_rad - imu_yaw_rad);
  if (fabsf(error) <= YAW_HOLD_TOLERANCE_RAD) {
    previous_yaw_error = error;
    yaw_correction_wz = 0.0f;
    yaw_stall_seconds = 0.0f;
    return 0.0f;
  }
  const float derivative = (error - previous_yaw_error) / max(dt, 0.001f);
  previous_yaw_error = error;
  yaw_correction_wz = constrain(yaw_hold_kp * error + yaw_hold_kd * derivative,
                                -yaw_hold_max_wz_radps, yaw_hold_max_wz_radps);
  // Loaded wheels have a small static-friction dead zone. Apply the minimum
  // effort only after yaw has actually been stationary for 150 ms; never
  // override D braking while the robot is still rotating.
  if (fabsf(derivative) < YAW_STALL_RATE_RADPS) {
    yaw_stall_seconds += dt;
  } else {
    yaw_stall_seconds = 0.0f;
  }
  if (yaw_stall_seconds >= YAW_STALL_CONFIRM_SEC &&
      fabsf(yaw_correction_wz) < YAW_MIN_EFFECTIVE_WZ_RADPS) {
    yaw_correction_wz = copysignf(YAW_MIN_EFFECTIVE_WZ_RADPS, error);
  }
  return yaw_correction_wz;
}

float computeYawToTarget(float target_yaw, float dt, float measured_rate) {
  if (!heading_available) return 0.0f;
  const float error = wrapAngle(target_yaw - imu_yaw_rad);
  if (fabsf(error) <= YAW_HOLD_TOLERANCE_RAD && fabsf(measured_rate) < 0.03f) {
    previous_yaw_error = error;
    yaw_correction_wz = 0.0f;
    yaw_stall_seconds = 0.0f;
    return 0.0f;
  }
  const float derivative = -measured_rate;
  previous_yaw_error = error;
  yaw_correction_wz = constrain(yaw_hold_kp * error + yaw_hold_kd * derivative,
                                -yaw_hold_max_wz_radps, yaw_hold_max_wz_radps);
  // Position/yaw goals need the same loaded-wheel breakaway compensation as
  // heading hold.  Apply it only after yaw is stationary so it cannot defeat
  // derivative braking while the chassis is still rotating.
  if (fabsf(derivative) < YAW_STALL_RATE_RADPS) {
    yaw_stall_seconds += dt;
  } else {
    yaw_stall_seconds = 0.0f;
  }
  if (fabsf(error) > YAW_HOLD_TOLERANCE_RAD && yaw_stall_seconds >= YAW_STALL_CONFIRM_SEC &&
      fabsf(yaw_correction_wz) < YAW_MIN_EFFECTIVE_WZ_RADPS) {
    yaw_correction_wz = copysignf(YAW_MIN_EFFECTIVE_WZ_RADPS, error);
  }
  return yaw_correction_wz;
}

AxisPid position_x_pid;
AxisPid position_y_pid;
float position_linear_max_mps = 0.35f;
float position_angular_max_radps = 1.50f;

// Scalar Kalman estimator for quantised encoder velocity.  It smooths the
// measurement used by PID/telemetry; it does not hide a real mechanical
// overshoot.  Q/R are deliberately conservative for 600 ticks/rev at 50 Hz.
struct VelocityKalman {
  float estimate = 0.0f;
  float covariance = 25.0f;
  void reset(float value = 0.0f) { estimate = value; covariance = 25.0f; }
  float update(float measurement) {
    constexpr float process_noise = 4.0f;
    constexpr float measurement_noise = 36.0f;
    covariance += process_noise;
    const float gain = covariance / (covariance + measurement_noise);
    estimate += gain * (measurement - estimate);
    covariance *= (1.0f - gain);
    return estimate;
  }
};

struct WheelState {
  volatile long ticks = 0;
  long previous_ticks = 0;
  float raw_rpm = 0.0f;
  float rpm = 0.0f;
  float command_rpm = 0.0f;
  float target_rpm = 0.0f;
  float pwm = 0.0f;
  Pid pid;
  VelocityKalman kalman;
};

WheelState wheel[WHEEL_COUNT];
HardwareTimer timer1(TIM1);
HardwareTimer timer4(TIM4);
constexpr uint32_t MOTOR_PWM_FREQUENCY_HZ = 20000;
uint8_t selected_mask = 0;
bool tuner_enabled = false;
bool pid_override = false;
bool twist_active = false;
OmniTwist commanded_twist = {0.0f, 0.0f, 0.0f};
volatile long odom_x_ticks = 0;
volatile long odom_y_ticks = 0;
long previous_odom_x_ticks = 0;
long previous_odom_y_ticks = 0;
float pose_x_m = 0.0f;
float pose_y_m = 0.0f;
float raw_pose_x_m = 0.0f;
float raw_pose_y_m = 0.0f;
PositionKalman odom_x_kalman;
PositionKalman odom_y_kalman;
OdomRateGate odom_x_rate_gate;
OdomRateGate odom_y_rate_gate;
float previous_pose_yaw_rad = 0.0f;
float goal_x_m = 0.0f;
float goal_y_m = 0.0f;
float goal_yaw_rad = 0.0f;
bool position_active = false;
float position_vx_world = 0.0f, position_vy_world = 0.0f;
float position_previous_yaw = 0.0f, position_yaw_rate = 0.0f;
float position_settled_seconds = 0.0f;
bool position_saturated = false;
bool open_loop_active = false;
int open_loop_pwm = 0;
unsigned long last_open_loop_command_ms = 0;
constexpr uint32_t OPEN_LOOP_TIMEOUT_MS = 400;
bool goal_reached_announced = false;
constexpr float POSITION_TOLERANCE_M = 0.010f;
float requested_rpm = 0.0f;
unsigned long last_command_ms = 0;
unsigned long last_control_ms = 0;
unsigned long last_telemetry_ms = 0;
char command_buffer[96];
size_t command_length = 0;
volatile uint32_t last_encoder_edge_us[WHEEL_COUNT] = {};

void encoderISR(uint8_t index) {
  const WheelConfig &cfg = WHEELS[index];
  // At 600 ticks/rev and 500 RPM, real rising edges are about 200 us apart.
  // Ignore shorter bursts from contact bounce or motor/PWM interference.
  const uint32_t now = micros();
  if (last_encoder_edge_us[index] && now - last_encoder_edge_us[index] < 120) {
    return;
  }
  last_encoder_edge_us[index] = now;
  // All four speed encoders occupy PA0..PA7 in FL/FR/RL/RR order. Reading
  // GPIOA directly avoids the generic digitalRead lookup on every pulse.
  const uint8_t other_bit = index * 2 + (cfg.encoder_interrupt_on_b ? 0 : 1);
  const bool other_phase = (GPIOA->IDR >> other_bit) & 1u;
  // B-rising samples the opposite phase from A-rising for the same direction.
  const long delta = (other_phase ^ cfg.encoder_inverted ^ cfg.encoder_interrupt_on_b) ? 1 : -1;
  wheel[index].ticks += delta;
}
void encoderFL() { encoderISR(FL); }
void encoderFR() { encoderISR(FR); }
void encoderRL() { encoderISR(RL); }
void encoderRR() { encoderISR(RR); }
void encoderOdomX() {
  const bool forward = digitalRead(ODOM_X_ENCODER_B);
  odom_x_ticks += (forward ^ ODOM_X_ENCODER_INVERTED) ? 1 : -1;
}
void encoderOdomY() {
  const bool forward = digitalRead(ODOM_Y_ENCODER_B);
  odom_y_ticks += (forward ^ ODOM_Y_ENCODER_INVERTED) ? 1 : -1;
}

HardwareTimer &timerFor(TIM_TypeDef *timer) {
  return timer == TIM1 ? timer1 : timer4;
}

void setMotor(uint8_t index, float signed_pwm) {
  const WheelConfig &cfg = WHEELS[index];
  if (cfg.motor_inverted) signed_pwm = -signed_pwm;
  const int duty = constrain(static_cast<int>(fabsf(signed_pwm)), 0, MAX_PWM);
  digitalWrite(cfg.direction_pin, signed_pwm >= 0.0f ? HIGH : LOW);
  timerFor(cfg.pwm_timer).setCaptureCompare(
      cfg.pwm_channel, duty, RESOLUTION_8B_COMPARE_FORMAT);
  wheel[index].pwm = signed_pwm;
}

float feedForwardPwm(uint8_t index, float target_rpm) {
  if (fabsf(target_rpm) < 0.5f) return 0.0f;
  const float magnitude = FEEDFORWARD_STATIC_PWM[index] +
                          FEEDFORWARD_PWM_PER_RPM[index] * fabsf(target_rpm);
  return target_rpm >= 0.0f ? magnitude : -magnitude;
}

void stopAll(bool clear_targets = true) {
  position_vx_world = position_vy_world = position_settled_seconds = 0.0f;
  position_x_pid.integral = position_y_pid.integral = 0.0f;
  position_saturated = false;
  commanded_twist = {0.0f, 0.0f, 0.0f};
  tuner_enabled = false;
  twist_active = false;
  position_active = false;
  open_loop_active = false;
  open_loop_pwm = 0;
  goal_reached_announced = false;
  yaw_target_latched = false;
  yaw_correction_wz = 0.0f;
  yaw_stall_seconds = 0.0f;
  requested_rpm = 0.0f;
  selected_mask = 0;
  for (uint8_t i = 0; i < WHEEL_COUNT; ++i) {
    if (clear_targets) {
      wheel[i].command_rpm = 0.0f;
      wheel[i].target_rpm = 0.0f;
    }
    wheel[i].pid.integral = 0.0f;
    wheel[i].pid.previous_error = 0.0f;
    wheel[i].kalman.reset();
    setMotor(i, 0.0f);
  }
}

void resetPose() {
  noInterrupts();
  odom_x_ticks = odom_y_ticks = 0;
  previous_odom_x_ticks = previous_odom_y_ticks = 0;
  interrupts();
  pose_x_m = pose_y_m = 0.0f;
  raw_pose_x_m = raw_pose_y_m = 0.0f;
  odom_x_kalman.reset();
  odom_y_kalman.reset();
  odom_x_rate_gate.reset();
  odom_y_rate_gate.reset();
  previous_pose_yaw_rad = imu_yaw_rad;
  goal_x_m = goal_y_m = 0.0f;
  goal_yaw_rad = imu_yaw_rad;
  position_x_pid.integral = position_y_pid.integral = 0.0f;
  position_x_pid.resetMeasurement(0.0f);
  position_y_pid.resetMeasurement(0.0f);
  position_previous_yaw = imu_yaw_rad;
  position_yaw_rate = 0.0f;
  position_vx_world = position_vy_world = position_settled_seconds = 0.0f;
}

void updatePose(float dt) {
  long x_ticks, y_ticks;
  noInterrupts();
  x_ticks = odom_x_ticks;
  y_ticks = odom_y_ticks;
  interrupts();
  const long delta_x_ticks = x_ticks - previous_odom_x_ticks;
  const long delta_y_ticks = y_ticks - previous_odom_y_ticks;
  previous_odom_x_ticks = x_ticks;
  previous_odom_y_ticks = y_ticks;

  const float tick_to_distance = (2.0f * PI * ODOM_WHEEL_RADIUS_M) / ODOM_TICKS_PER_REV;
  const float safe_dt = max(dt, 0.001f);
  // A pulse burst from a noisy input must not become metres of fictitious
  // robot motion. The 3.6 m/s gate allows a 500-RPM straight-wheel test
  // while rejecting much larger bursts. Update the raw-tick baseline on rejection
  // so a burst cannot leak into the next cycle.
  const bool x_valid = odom_x_rate_gate.accept(delta_x_ticks, tick_to_distance, safe_dt);
  const bool y_valid = odom_y_rate_gate.accept(delta_y_ticks, tick_to_distance, safe_dt);
  if ((!x_valid || !y_valid) && tuner_enabled) {
    stopAll();
    tunerSerial.println("T:ERR:ODOM_OUTLIER");
  }
  const float delta_yaw = wrapAngle(imu_yaw_rad - previous_pose_yaw_rad);
  previous_pose_yaw_rad = imu_yaw_rad;
  // Remove the tangential distance caused by robot rotation at each measuring
  // wheel. Only the coordinate perpendicular to that wheel's measuring axis
  // contributes: y for the X wheel and x for the Y wheel.
  const float robot_dx = (x_valid ? delta_x_ticks * tick_to_distance : 0.0f) -
                         ODOM_X_OFFSET_Y_M * delta_yaw;
  const float robot_dy = (y_valid ? delta_y_ticks * tick_to_distance : 0.0f) +
                         ODOM_Y_OFFSET_X_M * delta_yaw;
  raw_pose_x_m += robot_dx * cosf(imu_yaw_rad) - robot_dy * sinf(imu_yaw_rad);
  raw_pose_y_m += robot_dx * sinf(imu_yaw_rad) + robot_dy * cosf(imu_yaw_rad);
  pose_x_m = odom_x_kalman.update(raw_pose_x_m, safe_dt);
  pose_y_m = odom_y_kalman.update(raw_pose_y_m, safe_dt);
}

void updatePositionControl(float dt) {
  const float error_x_world = goal_x_m - pose_x_m;
  const float error_y_world = goal_y_m - pose_y_m;
  const float error_yaw = wrapAngle(goal_yaw_rad - imu_yaw_rad);
  if (hypotf(error_x_world, error_y_world) <= POSITION_TOLERANCE_M &&
      fabsf(error_yaw) <= YAW_HOLD_TOLERANCE_RAD &&
      hypotf(position_x_pid.velocity, position_y_pid.velocity) < 0.02f &&
      fabsf(position_yaw_rate) < 0.03f) {
    position_settled_seconds += dt;
  } else {
    position_settled_seconds = 0.0f;
  }
  if (position_settled_seconds >= 0.15f) {
    for (uint8_t i = 0; i < WHEEL_COUNT; ++i) wheel[i].command_rpm = 0.0f;
    position_x_pid.integral = position_y_pid.integral = 0.0f;
    position_saturated = false;
    position_vx_world = position_vy_world = 0.0f;
    commanded_twist = {0.0f, 0.0f, 0.0f};
    if (!goal_reached_announced) tunerSerial.println("T:GOAL_REACHED");
    goal_reached_announced = true;
    return;
  }
  goal_reached_announced = false;
  // Tune X/Y in the same world frame as GOAL. Heading changes must not swap
  // axis gains or create a derivative kick. Both axes stay active throughout.
  const float old_ix = position_x_pid.integral, old_iy = position_y_pid.integral;
  float vx = position_x_pid.output(error_x_world, dt, !position_saturated);
  float vy = position_y_pid.output(error_y_world, dt, !position_saturated);
  const float magnitude = hypotf(vx, vy);
  position_saturated = magnitude > position_linear_max_mps;
  if (position_saturated) {
    vx *= position_linear_max_mps / magnitude;
    vy *= position_linear_max_mps / magnitude;
  }
  rampPositionVector(position_vx_world, position_vy_world, vx, vy,
                     position_linear_max_mps, dt);
  position_saturated |= hypotf(vx - position_vx_world, vy - position_vy_world) > 0.0001f;
  commanded_twist = {
    position_vx_world * cosf(imu_yaw_rad) + position_vy_world * sinf(imu_yaw_rad),
    -position_vx_world * sinf(imu_yaw_rad) + position_vy_world * cosf(imu_yaw_rad),
    computeYawToTarget(goal_yaw_rad, dt, position_yaw_rate),
  };
  commanded_twist.wz_radps = constrain(commanded_twist.wz_radps,
                                     -position_angular_max_radps, position_angular_max_radps);
  const float conversion = 60.0f / (2.0f * PI * DRIVE_WHEEL_RADIUS_M);
  const float turn = constrain((OMNI_HALF_LENGTH_M + OMNI_HALF_WIDTH_M) *
      commanded_twist.wz_radps * conversion, -MAX_RPM, MAX_RPM);
  const float a = (commanded_twist.vx_mps - commanded_twist.vy_mps) * conversion;
  const float b = (commanded_twist.vx_mps + commanded_twist.vy_mps) * conversion;
  float rpm[WHEEL_COUNT] = {a, b, b, a};
  const float yaw_rpm[WHEEL_COUNT] = {-turn, turn, -turn, turn};
  const float scale = mixPositionWheels(rpm, yaw_rpm, MAX_RPM);
  position_vx_world *= scale; position_vy_world *= scale;
  commanded_twist.vx_mps *= scale; commanded_twist.vy_mps *= scale;
  position_saturated |= scale < 0.9999f;
  if (position_saturated) {
    // Permit stored I to unwind, but never grow while downstream is limited.
    if (fabsf(position_x_pid.integral) > fabsf(old_ix)) position_x_pid.integral = old_ix;
    if (fabsf(position_y_pid.integral) > fabsf(old_iy)) position_y_pid.integral = old_iy;
  }
  for (uint8_t i = 0; i < WHEEL_COUNT; ++i) wheel[i].command_rpm = rpm[i];
}

void sendTelemetry() {
  // Separate frame preserves the existing TEL protocol for older clients.
  tunerSerial.print("T:TARGET:"); tunerSerial.print(millis());
  for (uint8_t i = 0; i < WHEEL_COUNT; ++i) {
    tunerSerial.print(':'); tunerSerial.print(wheel[i].target_rpm, 2);
  }
  tunerSerial.println();
  tunerSerial.print("T:TEL:");
  tunerSerial.print(millis());
  tunerSerial.print(':');
  tunerSerial.print(selected_mask);
  tunerSerial.print(':');
  tunerSerial.print(requested_rpm, 2);
  for (uint8_t i = 0; i < WHEEL_COUNT; ++i) { tunerSerial.print(':'); tunerSerial.print(wheel[i].rpm, 2); }
  for (uint8_t i = 0; i < WHEEL_COUNT; ++i) { tunerSerial.print(':'); tunerSerial.print(wheel[i].raw_rpm, 2); }
  for (uint8_t i = 0; i < WHEEL_COUNT; ++i) { tunerSerial.print(':'); tunerSerial.print(wheel[i].ticks); }
  for (uint8_t i = 0; i < WHEEL_COUNT; ++i) { tunerSerial.print(':'); tunerSerial.print(wheel[i].pwm, 1); }
  tunerSerial.println();
}



void sendPoseTelemetry() {
  tunerSerial.print("T:POSE:");
  tunerSerial.print(pose_x_m, 4); tunerSerial.print(':');
  tunerSerial.print(pose_y_m, 4); tunerSerial.print(':');
  tunerSerial.print(imu_yaw_rad, 4); tunerSerial.print(':');
  tunerSerial.print(goal_x_m, 4); tunerSerial.print(':');
  tunerSerial.print(goal_y_m, 4); tunerSerial.print(':');
  tunerSerial.print(goal_yaw_rad, 4); tunerSerial.print(':');
  tunerSerial.print(position_active ? 1 : 0); tunerSerial.print(':');
  tunerSerial.println(imu_ok && millis() - last_imu_update_ms <= 250 ? 1 : 0);
}

bool parseFloat3(const String &text, float &a, float &b, float &c) {
  const char *cursor = text.c_str();
  float *values[3] = {&a, &b, &c};
  for (uint8_t i = 0; i < 3; ++i) {
    char *end;
    *values[i] = strtof(cursor, &end);
    if (end == cursor || !isfinite(*values[i]) || *end != (i < 2 ? ':' : '\0')) return false;
    cursor = end + (i < 2 ? 1 : 0);
  }
  return true;
}

// T:SELECT:<mask> mask 1,2,4,8 for individual wheels; 15 for all wheels.
// T:PID:<kp>:<ki>:<kd>, T:RPM:<signed rpm>, T:START, T:STOP, T:STATUS
// T:TWIST:<vx_mps>:<vy_mps>:<wz_radps> sends an X-drive omni motion command.
// With wz=0, yaw hold keeps the heading captured at the start of translation.
// T:YAW_HOLD:0 or :1 disables/enables this behaviour.
// T:GOAL:<x_m>:<y_m>:<yaw_rad> enables global-frame XY position control.
// T:POS_PID_X:<kp>:<ki>:<kd>, T:POS_PID_Y:<kp>:<ki>:<kd>,
// T:YAW_PID:<kp>:<kd>:<max_wz_radps>, T:POSE_RESET.
// T:POS_SPEED:<linear_mps>:<angular_radps> sets positive position-mode limits.
// T:OPEN_LOOP:<0..3> scales straight-ahead PWM; repeat faster than 400 ms.
// This is a power command, not measured speed or position control.
void processCommand(const char *raw) {
  const String command(raw);
  if (!command.startsWith("T:")) return;
  last_command_ms = millis();
  if (command.startsWith("T:SELECT:")) {
    if (open_loop_active) stopAll();
    const int mask = command.substring(9).toInt();
    selected_mask = constrain(mask, 0, 15);
    twist_active = false;
    position_active = false;
    pid_override = false;  // a new wheel selection returns to its speed preset
    tunerSerial.println("T:ACK:SELECT");
  } else if (command.startsWith("T:PID:")) {
    float kp, ki, kd;
    if (!parseFloat3(command.substring(6), kp, ki, kd) || kp < 0 || ki < 0 || kd < 0) {
      tunerSerial.println("T:ERR:PID"); return;
    }
    for (uint8_t i = 0; i < WHEEL_COUNT; ++i) if (selected_mask & (1 << i)) {
      wheel[i].pid = {kp, ki, kd, 0.0f, 0.0f};
    }
    pid_override = true;
    tunerSerial.println("T:ACK:PID");
  } else if (command.startsWith("T:RPM:")) {
    if (open_loop_active) stopAll();
    twist_active = false;
    position_active = false;
    requested_rpm = constrain(command.substring(6).toFloat(), -MAX_RPM, MAX_RPM);
    if (!pid_override) {
      const PidGains gains = pidGainsForSpeed(requested_rpm);
      for (uint8_t i = 0; i < WHEEL_COUNT; ++i) if (selected_mask & (1 << i)) {
        wheel[i].pid = {gains.kp, gains.ki, gains.kd, 0.0f, 0.0f};
      }
    }
    for (uint8_t i = 0; i < WHEEL_COUNT; ++i) wheel[i].command_rpm =
        (selected_mask & (1 << i)) ? requested_rpm : 0.0f;
    tunerSerial.println("T:ACK:RPM");
  } else if (command.startsWith("T:TWIST:")) {
    if (open_loop_active) stopAll();
    position_active = false;
    float vx, vy, wz;
    if (!parseFloat3(command.substring(8), vx, vy, wz)) {
      tunerSerial.println("T:ERR:TWIST"); return;
    }
    commanded_twist = {vx, vy, wz};
    selected_mask = 0x0F;
    requested_rpm = 0.0f;  // A twist has one target per wheel, not one shared RPM.
    twist_active = true;
    if (fabsf(wz) <= YAW_COMMAND_DEADBAND_RADPS) yaw_target_latched = false;
    tuner_enabled = true;
    tunerSerial.println("T:ACK:TWIST");
  } else if (command.startsWith("T:OPEN_LOOP:")) {
    const char *value = raw + 12;
    char *end;
    const float speed = strtof(value, &end);
    if (end == value || *end != '\0' || !isfinite(speed) ||
        speed < 0.0f || speed > OPEN_LOOP_FULL_PWM_REQUEST_MPS) {
      tunerSerial.println("T:ERR:OPEN_LOOP"); return;
    }
    if (speed == 0.0f) {
      stopAll();
    } else {
      if (!open_loop_active) stopAll();
      open_loop_pwm = openLoopPwmForSpeed(speed);
      requested_rpm = speed * 60.0f / (2.0f * PI * DRIVE_WHEEL_RADIUS_M);
      for (uint8_t i = 0; i < WHEEL_COUNT; ++i) {
        wheel[i].command_rpm = requested_rpm;
        wheel[i].target_rpm = requested_rpm;
      }
      selected_mask = 0x0F;
      open_loop_active = true;
      tuner_enabled = true;
      last_open_loop_command_ms = millis();
    }
    tunerSerial.println("T:ACK:OPEN_LOOP");
  } else if (command.startsWith("T:GOAL:")) {
    float x, y, yaw;
    if (!parseFloat3(command.substring(7), x, y, yaw) ||
        !isfinite(x) || !isfinite(y) || !isfinite(yaw) ||
        !isfinite(hypotf(x - pose_x_m, y - pose_y_m))) {
      tunerSerial.println("T:ERR:GOAL"); return;
    }
    if (!heading_available) {
      tunerSerial.println("T:ERR:HEADING_UNAVAILABLE"); return;
    }
    if (open_loop_active) stopAll();
    const float bounded_yaw = wrapAngle(yaw);
    if (!position_active) {
      stopAll();
      position_vx_world = position_x_pid.velocity;
      position_vy_world = position_y_pid.velocity;
    }
    const bool goal_changed = !position_active || fabsf(goal_x_m - x) > 0.0001f ||
                              fabsf(goal_y_m - y) > 0.0001f ||
                              fabsf(wrapAngle(goal_yaw_rad - bounded_yaw)) > 0.0001f;
    goal_x_m = x;
    goal_y_m = y;
    goal_yaw_rad = bounded_yaw;
    if (goal_changed) {
      position_x_pid.integral = position_y_pid.integral = 0.0f;
      previous_yaw_error = 0.0f;
      yaw_stall_seconds = position_settled_seconds = 0.0f;
      goal_reached_announced = false;
    }
    selected_mask = 0x0F;
    twist_active = false;
    position_active = true;
    tuner_enabled = true;
    tunerSerial.println("T:ACK:GOAL");
  } else if (command == "T:POSE_RESET") {
    resetPose();
    tunerSerial.println("T:ACK:POSE_RESET");
  } else if (command.startsWith("T:POS_SPEED:")) {
    const char *values = raw + 12;
    char *end;
    const float linear = strtof(values, &end);
    if (end == values || *end != ':') {
      tunerSerial.println("T:ERR:POS_SPEED"); return;
    }
    values = end + 1;
    const float angular = strtof(values, &end);
    if (end == values || *end != '\0' || !isfinite(linear) || !isfinite(angular) ||
        linear <= 0 ||
        angular <= 0 || angular > 5.0f) {
      tunerSerial.println("T:ERR:POS_SPEED"); return;
    }
    if (yaw_profile_active) {
      const YawProfile *profile = findYawProfile(angular);
      if (!profile) { tunerSerial.println("T:ERR:YAW_PROFILE"); return; }
      yaw_hold_kp = profile->kp;
      yaw_hold_kd = profile->kd;
      yaw_hold_max_wz_radps = profile->speed_radps;
    }
    // Accept any positive requested cap, but commands cannot exceed the
    // existing 500-RPM motor ceiling. Avoid huge PID limits/float overflow.
    const float motor_linear_ceiling_mps =
        MAX_RPM * (2.0f * PI * DRIVE_WHEEL_RADIUS_M) / 60.0f;
    const float effective_linear = fminf(linear, motor_linear_ceiling_mps);
    position_linear_max_mps = effective_linear;
    position_angular_max_radps = angular;
    position_x_pid.output_limit_mps = position_y_pid.output_limit_mps = effective_linear;
    tunerSerial.println("T:ACK:POS_SPEED");
  } else if (command.startsWith("T:POS_PID_X:")) {
    float kp, ki, kd;
    if (!parseFloat3(command.substring(12), kp, ki, kd) ||
        !isfinite(kp) || !isfinite(ki) || !isfinite(kd) ||
        kp < 0 || ki < 0 || kd < 0 || kp > 100 || ki > 100 || kd > 100) {
      tunerSerial.println("T:ERR:POS_PID_X"); return;
    }
    position_x_pid.kp = kp; position_x_pid.ki = ki; position_x_pid.kd = kd;
    position_x_pid.integral = 0.0f;
    tunerSerial.println("T:ACK:POS_PID_X");
  } else if (command.startsWith("T:POS_PID_Y:")) {
    float kp, ki, kd;
    if (!parseFloat3(command.substring(12), kp, ki, kd) ||
        !isfinite(kp) || !isfinite(ki) || !isfinite(kd) ||
        kp < 0 || ki < 0 || kd < 0 || kp > 100 || ki > 100 || kd > 100) {
      tunerSerial.println("T:ERR:POS_PID_Y"); return;
    }
    position_y_pid.kp = kp; position_y_pid.ki = ki; position_y_pid.kd = kd;
    position_y_pid.integral = 0.0f;
    tunerSerial.println("T:ACK:POS_PID_Y");
  } else if (command.startsWith("T:YAW_PROFILE:")) {
    char *end;
    const float speed = strtof(raw + 14, &end);
    const YawProfile *profile = findYawProfile(speed);
    if (end == raw + 14 || *end != '\0' || !profile) {
      tunerSerial.println("T:ERR:YAW_PROFILE"); return;
    }
    yaw_hold_kp = profile->kp;
    yaw_hold_kd = profile->kd;
    yaw_hold_max_wz_radps = position_angular_max_radps = profile->speed_radps;
    yaw_profile_active = true;
    previous_yaw_error = 0.0f;
    tunerSerial.println("T:ACK:YAW_PROFILE");
  } else if (command.startsWith("T:YAW_PID:")) {
    float kp, kd, maximum;
    if (!parseFloat3(command.substring(10), kp, kd, maximum) || kp < 0 || kd < 0 || maximum <= 0) {
      tunerSerial.println("T:ERR:YAW_PID"); return;
    }
    yaw_hold_kp = kp;
    yaw_hold_kd = kd;
    yaw_hold_max_wz_radps = maximum;
    yaw_profile_active = false;
    previous_yaw_error = 0.0f;
    tunerSerial.println("T:ACK:YAW_PID");
  } else if (command.startsWith("T:YAW_HOLD:")) {
    yaw_hold_enabled = command.substring(11).toInt() != 0;
    yaw_target_latched = false;
    yaw_correction_wz = 0.0f;
    tunerSerial.println(yaw_hold_enabled ? "T:ACK:YAW_HOLD:1" : "T:ACK:YAW_HOLD:0");
  } else if (command == "T:I2C_SCAN") {
    scanI2cBus();
    tunerSerial.println("T:ACK:I2C_SCAN");
  } else if (command == "T:START") {
    if (selected_mask == 0) { tunerSerial.println("T:ERR:NO_WHEEL"); return; }
    tuner_enabled = true;
    tunerSerial.println("T:ACK:START");
  } else if (command == "T:STOP") {
    stopAll(); tunerSerial.println("T:ACK:STOP");
  } else if (command == "T:STATUS") {
    sendTelemetry();
  } else {
    tunerSerial.println("T:ERR:COMMAND");
  }
}

void readSerial() {
  while (tunerSerial.available()) {
    const char c = static_cast<char>(tunerSerial.read());
    if (c == '\n' || c == '\r') {
      if (command_length) { command_buffer[command_length] = '\0'; processCommand(command_buffer); command_length = 0; }
    } else if (command_length < sizeof(command_buffer) - 1) {
      command_buffer[command_length++] = c;
    } else {
      command_length = 0;
      tunerSerial.println("T:ERR:TOO_LONG");
    }
  }
}

void controlStep(float dt) {
  long ticks[WHEEL_COUNT];
  noInterrupts();
  for (uint8_t i = 0; i < WHEEL_COUNT; ++i) ticks[i] = wheel[i].ticks;
  interrupts();
  const bool imu_fresh = imu_ok && millis() - last_imu_update_ms <= 250;
  float wheel_delta[WHEEL_COUNT];
  bool encoders_valid = true;
  for (uint8_t i = 0; i < WHEEL_COUNT; ++i) {
    wheel_delta[i] = static_cast<float>(ticks[i] - wheel[i].previous_ticks);
    encoders_valid &= WHEEL_ENCODER_AVAILABLE[i] &&
        fabsf(wheel_delta[i]) <= MAX_RPM * 1.5f * TICKS_PER_REV * dt / 60.0f + 2.0f;
  }
  heading_available = imu_fresh || encoders_valid;
  if (position_active && !heading_available) {
    stopAll(); tunerSerial.println("T:SAFE_STOP:heading_unavailable");
  }
  const float delta_heading = encoders_valid ?
      (-wheel_delta[FL] + wheel_delta[FR] - wheel_delta[RL] + wheel_delta[RR]) *
      (2.0f * PI * DRIVE_WHEEL_RADIUS_M) /
      (TICKS_PER_REV * 4.0f * (OMNI_HALF_LENGTH_M + OMNI_HALF_WIDTH_M)) : 0.0f;
  imu_yaw_rad = estimateHeading(imu_yaw_rad, delta_heading, imu_fresh, sensor_yaw_rad, dt);
  updatePose(dt);
  position_x_pid.observe(pose_x_m, dt);
  position_y_pid.observe(pose_y_m, dt);
  const float measured_yaw_rate = wrapAngle(imu_yaw_rad - position_previous_yaw) / max(dt, 0.001f);
  position_yaw_rate += dt / (0.04f + dt) * (measured_yaw_rate - position_yaw_rate);
  position_previous_yaw = imu_yaw_rad;
  if (tuner_enabled && position_active) {
    updatePositionControl(dt);
  } else if (tuner_enabled && twist_active) {
    OmniTwist corrected = commanded_twist;
    corrected.wz_radps = computeYawHold(commanded_twist.wz_radps, dt);
    float rpm[WHEEL_COUNT];
    omniTwistToRpm(corrected, rpm);
    for (uint8_t i = 0; i < WHEEL_COUNT; ++i) wheel[i].command_rpm = rpm[i];
  }
  for (uint8_t i = 0; i < WHEEL_COUNT; ++i) {
    WheelState &state = wheel[i];
    state.raw_rpm = (ticks[i] - state.previous_ticks) * (60.0f / (TICKS_PER_REV * dt));
    state.previous_ticks = ticks[i];
    // A burst above the configured wheel envelope is electrical noise, not
    // a speed measurement. Keep it out of the display and PID feedback.
    if (fabsf(state.raw_rpm) > MAX_RPM * 1.5f) state.raw_rpm = 0.0f;
    state.rpm = state.kalman.update(state.raw_rpm);
    if (open_loop_active) {
      setMotor(i, static_cast<float>(open_loop_pwm));
      continue;
    }
    if (!tuner_enabled || !(selected_mask & (1 << i))) { setMotor(i, 0.0f); continue; }
    // GOAL already has one shared XY ramp. A second wheel ramp would delay
    // braking and distort heading correction. Manual wheel/twist keeps its ramp.
    if (position_active && goal_reached_announced) {
      state.target_rpm = 0.0f;
      state.pid.integral = state.pid.previous_error = 0.0f;
      setMotor(i, 0.0f);
      continue;
    }
    state.target_rpm = position_active ? state.command_rpm :
        rampWheelSetpoint(state.target_rpm, state.command_rpm, dt);
    if (!WHEEL_ENCODER_AVAILABLE[i]) {
      // A missing encoder must never be interpreted as a stationary motor:
      // closed-loop error would otherwise integrate until PWM saturates and
      // make yaw braking unpredictable.  Feed-forward is bounded and changes
      // direction with the ramped target, so STOP and reversal remain safe.
      state.pid.integral = 0.0f;
      state.pid.previous_error = 0.0f;
      setMotor(i, constrain(feedForwardPwm(i, state.target_rpm),
                            -static_cast<float>(MAX_PWM),
                            static_cast<float>(MAX_PWM)));
      continue;
    }
    const float error = state.target_rpm - state.rpm;
    const float old_integral = state.pid.integral;
    // Anti-windup must still allow the I term to provide the full available
    // PWM range.  The previous fixed +/-100 cap limited Ki=1.2 to +/-120 PWM,
    // which physically prevented this motor from reaching targets above about
    // 240 RPM.  Limit the I contribution to MAX_PWM instead.
    if (state.pid.ki > 0.001f) {
      const float integral_limit = static_cast<float>(MAX_PWM) / state.pid.ki;
      state.pid.integral = constrain(state.pid.integral + error * dt,
                                     -integral_limit, integral_limit);
    } else {
      state.pid.integral = 0.0f;
    }
    const float derivative = (error - state.pid.previous_error) / dt;
    state.pid.previous_error = error;
    float output = feedForwardPwm(i, state.target_rpm) +
                         state.pid.kp * error + state.pid.ki * state.pid.integral +
                         state.pid.kd * derivative;
    // Do not store extra forward effort while PWM is saturated: it would
    // remain after the position controller has already requested braking.
    if (state.pid.ki > 0.001f && fabsf(output) > MAX_PWM && output * error > 0.0f) {
      state.pid.integral = old_integral;
      output = feedForwardPwm(i, state.target_rpm) + state.pid.kp * error +
               state.pid.ki * state.pid.integral + state.pid.kd * derivative;
    }
    setMotor(i, constrain(output, -static_cast<float>(MAX_PWM), static_cast<float>(MAX_PWM)));
  }
}

void setup() {
  tunerSerial.setRx(PA10);
  tunerSerial.setTx(PA9);
  tunerSerial.begin(115200);
  
  for (uint8_t i = 0; i < WHEEL_COUNT; ++i) {
    pinMode(WHEELS[i].direction_pin, OUTPUT);
    pinMode(WHEELS[i].encoder_a, INPUT_PULLUP);
    pinMode(WHEELS[i].encoder_b, INPUT_PULLUP);
  }
  timer1.setMode(WHEELS[FL].pwm_channel, TIMER_OUTPUT_COMPARE_PWM1, WHEELS[FL].pwm_pin);
  timer1.setOverflow(MOTOR_PWM_FREQUENCY_HZ, HERTZ_FORMAT); timer1.resume();
  timer4.setMode(WHEELS[FR].pwm_channel, TIMER_OUTPUT_COMPARE_PWM1, WHEELS[FR].pwm_pin);
  timer4.setMode(WHEELS[RL].pwm_channel, TIMER_OUTPUT_COMPARE_PWM1, WHEELS[RL].pwm_pin);
  timer4.setMode(WHEELS[RR].pwm_channel, TIMER_OUTPUT_COMPARE_PWM1, WHEELS[RR].pwm_pin);
  timer4.setOverflow(MOTOR_PWM_FREQUENCY_HZ, HERTZ_FORMAT); timer4.resume();
  attachInterrupt(digitalPinToInterrupt(WHEELS[FL].encoder_interrupt_on_b ? WHEELS[FL].encoder_b : WHEELS[FL].encoder_a), encoderFL, RISING);
  attachInterrupt(digitalPinToInterrupt(WHEELS[FR].encoder_interrupt_on_b ? WHEELS[FR].encoder_b : WHEELS[FR].encoder_a), encoderFR, RISING);
  attachInterrupt(digitalPinToInterrupt(WHEELS[RL].encoder_interrupt_on_b ? WHEELS[RL].encoder_b : WHEELS[RL].encoder_a), encoderRL, RISING);
  attachInterrupt(digitalPinToInterrupt(WHEELS[RR].encoder_interrupt_on_b ? WHEELS[RR].encoder_b : WHEELS[RR].encoder_a), encoderRR, RISING);
  pinMode(ODOM_X_ENCODER_A, INPUT_PULLUP);
  pinMode(ODOM_X_ENCODER_B, INPUT_PULLUP);
  pinMode(ODOM_Y_ENCODER_A, INPUT_PULLUP);
  pinMode(ODOM_Y_ENCODER_B, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(ODOM_X_ENCODER_A), encoderOdomX, RISING);
  attachInterrupt(digitalPinToInterrupt(ODOM_Y_ENCODER_A), encoderOdomY, RISING);
  resetPose();
  stopAll();

  imu_ok = initialiseImu();
  position_previous_yaw = imu_yaw_rad;
  if (imu_ok) {
    tunerSerial.println("T:IMU:READY");
  } else {
    tunerSerial.println("T:WARN:IMU_INIT_FAILED:YAW_HOLD_OFF");
  }


  last_command_ms = last_control_ms = last_telemetry_ms = millis();
  tunerSerial.println("T:READY:wheel_tuner:600");
  tunerSerial.println("T:FW:xy-heading-fallback-20khz-v7");
}

void loop() {
  readSerial();
  updateImuYaw();
  const unsigned long now = millis();
  if (tuner_enabled && now - last_command_ms > COMMAND_TIMEOUT_MS) {
    stopAll(); tunerSerial.println("T:SAFE_STOP:timeout");
  }
  if (open_loop_active && now - last_open_loop_command_ms > OPEN_LOOP_TIMEOUT_MS) {
    stopAll(); tunerSerial.println("T:SAFE_STOP:open_loop_timeout");
  }
  if (now - last_control_ms >= CONTROL_PERIOD_MS) {
    const float dt = (now - last_control_ms) / 1000.0f;
    last_control_ms = now;
    controlStep(dt);
  }
  if (now - last_telemetry_ms >= TELEMETRY_PERIOD_MS) {
    last_telemetry_ms = now;
    sendTelemetry();
    sendPoseTelemetry();
  }
}
