#pragma once

#include <math.h>

// Manual wheel/twist ramp. GOAL uses the common XY ramp in position_profile.h.
constexpr float POSITION_ACCEL_RAMP_SECONDS = 0.50f;
constexpr float NORMAL_RAMP_RPM_PER_SEC = 250.0f;

inline float rampWheelSetpoint(float current_rpm, float command_rpm, float dt) {
  const float safe_dt = fmaxf(dt, 0.0f);
  const float max_step = NORMAL_RAMP_RPM_PER_SEC * safe_dt;
  const float delta = fmaxf(-max_step, fminf(command_rpm - current_rpm, max_step));
  return current_rpm + delta;
}
