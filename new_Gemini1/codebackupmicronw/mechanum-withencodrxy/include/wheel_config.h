#pragma once

#include <Arduino.h>

// Logical order shared by firmware, dashboard, and ROS: FL, FR, RL, RR.
enum Wheel : uint8_t { FL = 0, FR = 1, RL = 2, RR = 3, WHEEL_COUNT = 4 };

struct WheelConfig {
  // Arduino STM32 board pin identifiers (PA0, PB12, ...) are uint32_t values.
  uint32_t encoder_a;
  uint32_t encoder_b;
  uint32_t pwm_pin;
  uint32_t direction_pin;
  TIM_TypeDef *pwm_timer;
  uint32_t pwm_channel;
  bool motor_inverted;
  bool encoder_inverted;
  // Use B's rising edge when A shares an EXTI line with another sensor.
  bool encoder_interrupt_on_b;
};

// Current Mecanum wiring: speed encoders use PA0..PA7 in FL/FR/RL/RR order.
// Change this table together with the GPIOA ISR bit mapping when a channel
// moves. PWM pins must remain compatible with the
// specified timer/channel (or update both pwm_timer and pwm_channel too).
static WheelConfig WHEELS[WHEEL_COUNT] = {
  // PA0 shares EXTI0 with odometry X A=PB0: interrupt on FL B=PA1 instead.
  {PA0, PA1, PA8, PB12, TIM1, 1, false, false, true }, // FL
  {PA2, PA3, PB6, PB15, TIM4, 1, false, true, false }, // FR
  {PA4, PA5, PB7, PB13, TIM4, 2, false, true, false }, // RL
  {PA6, PA7, PB8, PB14, TIM4, 3, false, true, false }, // RR
};

// Recheck encoder polarity with the new wiring and wheels lifted before
// closed-loop speed control or loaded XY position tuning.
constexpr bool WHEEL_ENCODER_AVAILABLE[WHEEL_COUNT] = {true, true, true, true};


constexpr float TICKS_PER_REV = 600.0f;
constexpr uint32_t CONTROL_PERIOD_MS = 20;       // 50 Hz PID
constexpr uint32_t TELEMETRY_PERIOD_MS = 50;     // 20 Hz graph data
constexpr uint32_t COMMAND_TIMEOUT_MS = 1000;    // fail-safe motor stop
// Allows a 500-RPM setpoint for a supervised speed test. This is a command
// ceiling, not a claim that the loaded motor can reach 500 RPM.
constexpr float MAX_RPM = 500.0f;
constexpr int MAX_PWM = 255;

// Velocity-PID schedule used with the feed-forward model below.  Feed-forward
// provides most of the required motor effort, so the PID gains can be gentle
// enough to remove residual error without overshoot.
struct PidGains {
  float kp;
  float ki;
  float kd;
};

struct PidSpeedPreset {
  float rpm;
  PidGains gains;
};

constexpr PidSpeedPreset PID_SPEED_PRESETS[] = {
  { 50.0f, {0.80f, 0.35f, 0.0f}},
  {100.0f, {0.80f, 0.35f, 0.0f}},
  {150.0f, {0.80f, 0.35f, 0.0f}},
  {200.0f, {0.80f, 0.35f, 0.0f}},
  {250.0f, {0.80f, 0.35f, 0.0f}},
  {300.0f, {0.80f, 0.35f, 0.0f}},
  {350.0f, {0.80f, 0.35f, 0.0f}},
  {400.0f, {0.80f, 0.35f, 0.0f}},
};
// Above 400 RPM the 400-RPM gains are only a fallback; 500 RPM is not tuned.
constexpr uint8_t PID_SPEED_PRESET_COUNT = sizeof(PID_SPEED_PRESETS) / sizeof(PID_SPEED_PRESETS[0]);

inline PidGains pidGainsForSpeed(float signed_rpm) {
  const float rpm = fabsf(signed_rpm);
  uint8_t index = 0;
  for (uint8_t i = 1; i < PID_SPEED_PRESET_COUNT; ++i) {
    if (rpm >= PID_SPEED_PRESETS[i].rpm) index = i;
  }
  return PID_SPEED_PRESETS[index].gains;
}

// PWM ≈ static friction compensation + slope * RPM, identified from the
// 50-RPM and 400-RPM measurements of each physical wheel.  Electrical motor
// inversions are applied later by setMotor(), so these remain logical values.
constexpr float FEEDFORWARD_STATIC_PWM[WHEEL_COUNT] = {5.0f, 10.0f, 7.0f, 7.0f};
constexpr float FEEDFORWARD_PWM_PER_RPM[WHEEL_COUNT] = {0.531f, 0.594f, 0.580f, 0.531f};

// Passive/dead-wheel odometry. Robot origin is at the chassis centre, +X is
// forward from the rear edge and +Y points toward the left edge. Dimensions
// and encoder positions supplied on 2026-09-24 (converted cm -> metres):
//   chassis: 66.0 cm long x 66.2 cm wide
//   X encoder: 22.0 cm from rear, 33.1 cm from left
//   Y encoder: 33.0 cm from rear, 33.1 cm from left
constexpr uint32_t ODOM_X_ENCODER_A = PB0;
constexpr uint32_t ODOM_X_ENCODER_B = PB1;
constexpr uint32_t ODOM_Y_ENCODER_A = PB9;
constexpr uint32_t ODOM_Y_ENCODER_B = PB5;
constexpr float ODOM_TICKS_PER_REV = 600.0f;
constexpr float ODOM_WHEEL_RADIUS_M = 0.029f;

constexpr float ROBOT_LENGTH_M = 0.660f;
constexpr float ROBOT_WIDTH_M = 0.662f;
constexpr float ODOM_X_FROM_REAR_M = 0.220f;
constexpr float ODOM_X_FROM_LEFT_M = 0.331f;
constexpr float ODOM_Y_FROM_REAR_M = 0.330f;
constexpr float ODOM_Y_FROM_LEFT_M = 0.331f;

// Full sensor coordinates relative to the robot centre. A distance measured
// inward from the left edge has the opposite sign to robot-frame +Y.
constexpr float ODOM_X_POSITION_X_M = ODOM_X_FROM_REAR_M - ROBOT_LENGTH_M * 0.5f; // -0.110 m
constexpr float ODOM_X_POSITION_Y_M = ROBOT_WIDTH_M * 0.5f - ODOM_X_FROM_LEFT_M;   //  0.000 m
constexpr float ODOM_Y_POSITION_X_M = ODOM_Y_FROM_REAR_M - ROBOT_LENGTH_M * 0.5f; //  0.000 m
constexpr float ODOM_Y_POSITION_Y_M = ROBOT_WIDTH_M * 0.5f - ODOM_Y_FROM_LEFT_M;   //  0.000 m

// Rotation contributes -y*dYaw to an X-oriented wheel and +x*dYaw to a
// Y-oriented wheel. The X-coordinate of the X wheel (-0.110 m) does not enter
// its rotational correction; both effective offsets are therefore exactly 0.
constexpr float ODOM_X_OFFSET_Y_M = ODOM_X_POSITION_Y_M;
constexpr float ODOM_Y_OFFSET_X_M = ODOM_Y_POSITION_X_M;
// Match the ISR directions in the supplied old firmware.  Flip only after a
// physical forward/left displacement test proves the corresponding sign wrong.
constexpr bool ODOM_X_ENCODER_INVERTED = true;
constexpr bool ODOM_Y_ENCODER_INVERTED = false;
