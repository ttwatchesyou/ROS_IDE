#include "drive_geometry.h"
#include "open_loop_speed.h"

#include <assert.h>
#include <math.h>

int main() {
  constexpr float pi = 3.14159265358979323846f;
  assert(fabsf(DRIVE_WHEEL_DIAMETER_M - 0.127f) < 0.000001f);
  assert(fabsf(DRIVE_WHEEL_RADIUS_M - 0.0635f) < 0.000001f);
  const float rpm_for_3_mps =
      OPEN_LOOP_FULL_PWM_REQUEST_MPS * 60.0f / (2.0f * pi * DRIVE_WHEEL_RADIUS_M);
  assert(rpm_for_3_mps > 450.0f && rpm_for_3_mps < 452.0f);
  assert(openLoopPwmForSpeed(0.0f) == 0);
  assert(openLoopPwmForSpeed(1.5f) == 128);
  assert(openLoopPwmForSpeed(3.0f) == 255);
  assert(openLoopPwmForSpeed(5.0f) == 255);
}
