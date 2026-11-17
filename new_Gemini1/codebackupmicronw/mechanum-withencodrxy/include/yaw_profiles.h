#pragma once
#include <math.h>

// Yaw PD gains only. Existing yaw controller has no I term (Ki = 0).
// These constants are stored in STM32 flash when the firmware is uploaded.
// Measurements below were taken with the firmware currently on the board,
// before re-uploading this source. Keep disabled until each speed is retested
// against this source's unchanged wheel/encoder implementation.
// No interpolation: a missing/unconfirmed profile must not be selected.
struct YawProfile {
  float speed_radps;
  float kp;
  float kd;
  bool validated;
};

constexpr YawProfile YAW_PROFILES[] = {
  {0.5f, 4.0f, 0.4f, false},
  {1.0f, 4.4f, 0.4f, false},
  {1.5f, 4.8f, 0.5f, false},
  {2.0f, 4.0f, 1.2f, false},
  {2.5f, 4.0f, 1.6f, false},
  {3.0f, 4.8f, 1.8f, false},
};

inline const YawProfile *findYawProfile(float speed) {
  for (const auto &profile : YAW_PROFILES) {
    if (profile.validated && fabsf(profile.speed_radps - speed) < 0.001f)
      return &profile;
  }
  return nullptr;
}
