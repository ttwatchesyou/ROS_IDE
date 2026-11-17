#pragma once

#include <Arduino.h>
#include "wheel_config.h"
#include "drive_geometry.h"

// Four-wheel omni X-drive geometry.
// Robot frame: +X forward, +Y left, +W counter-clockwise.
// Wheel order: FL, FR, RL, RR.  The values here are physical wheel RPM;
// motor/encoder electrical inversions remain solely in WheelConfig.
//
// Set these from the real robot before autonomous driving.  HALF_LENGTH and
// HALF_WIDTH are measured from the centre of the chassis to each wheel axis.
constexpr float OMNI_HALF_LENGTH_M = 0.120f;
constexpr float OMNI_HALF_WIDTH_M = 0.120f;

struct OmniTwist {
  float vx_mps;       // forward (+)
  float vy_mps;       // left (+)
  float wz_radps;     // counter-clockwise (+)
};

inline void omniTwistToRpm(const OmniTwist &twist, float rpm[WHEEL_COUNT]) {
  const float turn = (OMNI_HALF_LENGTH_M + OMNI_HALF_WIDTH_M) * twist.wz_radps;
  constexpr float rad_per_sec_to_rpm = 60.0f / (2.0f * PI);
  const float scale = rad_per_sec_to_rpm / DRIVE_WHEEL_RADIUS_M;

  // 45-degree omni wheels in an X pattern:
  // FL = X - Y - (L+W)w, FR = X + Y + (L+W)w,
  // RL = X + Y - (L+W)w, RR = X - Y + (L+W)w.
  rpm[FL] = (twist.vx_mps - twist.vy_mps - turn) * scale;
  rpm[FR] = (twist.vx_mps + twist.vy_mps + turn) * scale;
  rpm[RL] = (twist.vx_mps + twist.vy_mps - turn) * scale;
  rpm[RR] = (twist.vx_mps - twist.vy_mps + turn) * scale;

  // Preserve the requested motion direction when one or more wheels reaches
  // its limit; do not independently clip an individual wheel.
  float maximum = 0.0f;
  for (uint8_t i = 0; i < WHEEL_COUNT; ++i) maximum = max(maximum, fabsf(rpm[i]));
  if (maximum > MAX_RPM) {
    const float limiter = MAX_RPM / maximum;
    for (uint8_t i = 0; i < WHEEL_COUNT; ++i) rpm[i] *= limiter;
  }
}
