#pragma once
#include <math.h>

inline float headingWrap(float value) {
  constexpr float pi = 3.14159265358979323846f;
  value = fmodf(value, 2.0f * pi);
  return value > pi ? value - 2.0f * pi : value < -pi ? value + 2.0f * pi : value;
}

// Wheel odometry bridges missing IMU reports; returning absolute IMU yaw
// corrects the estimate at a bounded rate rather than jumping the pose.
inline float estimateHeading(float heading, float wheel_delta,
                             bool imu_fresh, float imu_yaw, float dt) {
  float result = headingWrap(heading + wheel_delta);
  if (imu_fresh) {
    const float correction = headingWrap(imu_yaw - result);
    const float step = 2.0f * fmaxf(dt, 0.0f);
    result = headingWrap(result + fmaxf(-step, fminf(step, correction)));
  }
  return result;
}
