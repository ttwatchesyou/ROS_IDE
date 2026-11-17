#pragma once

#include <math.h>
#include "drive_geometry.h"

// Command scale only: 3 m/s on the UI requests full motor duty.
// It does not measure or guarantee 3 m/s or 500 RPM under load.
inline int openLoopPwmForSpeed(float requested_mps) {
  if (!isfinite(requested_mps) || requested_mps <= 0.0f) return 0;
  if (requested_mps >= OPEN_LOOP_FULL_PWM_REQUEST_MPS) return 255;
  return static_cast<int>(lroundf(255.0f * requested_mps / OPEN_LOOP_FULL_PWM_REQUEST_MPS));
}
