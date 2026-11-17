#pragma once

#include <math.h>
#include "speed_ramp.h"

// World-frame position PID. D acts on measured velocity, never on goal steps.
struct AxisPid {
  float kp = 3.0f, ki = 0.0f, kd = 0.10f;
  float integral = 0.0f, output_limit_mps = 0.35f;
  float previous_position = 0.0f, velocity = 0.0f;
  bool initialized = false;
  void observe(float position, float dt) {
    if (initialized && dt > 0.0f) {
      const float measured = (position - previous_position) / dt;
      velocity += dt / (0.04f + dt) * (measured - velocity);
    }
    previous_position = position; initialized = true;
  }
  void resetMeasurement(float position) {
    previous_position = position; velocity = integral = 0.0f; initialized = true;
  }
  float output(float error, float dt, bool integrate = true) {
    const float old = ki > 0.0f ? integral : 0.0f;
    if (ki <= 0.0f) integral = 0.0f;
    else if (integrate || error * integral < 0.0f) integral = fmaxf(-output_limit_mps / ki,
        fminf(output_limit_mps / ki, integral + error * dt));
    float result = kp * error + ki * integral - kd * velocity;
    if (fabsf(result) > output_limit_mps && result * error > 0.0f) {
      integral = old;
      result = kp * error + ki * integral - kd * velocity;
    }
    return fmaxf(-output_limit_mps, fminf(output_limit_mps, result));
  }
};

// Common XY ramp: 0 -> configured speed in 0.5 s, with equal deceleration.
inline void rampPositionVector(float &vx, float &vy, float target_x,
                               float target_y, float speed_limit, float dt) {
  const float dx = target_x - vx, dy = target_y - vy;
  const float delta = hypotf(dx, dy);
  const float step = speed_limit * fmaxf(dt, 0.0f) / POSITION_ACCEL_RAMP_SECONDS;
  const float scale = delta > step && delta > 0.0f ? step / delta : 1.0f;
  vx += dx * scale; vy += dy * scale;
}

// Reserve wheel headroom for yaw first, then scale XY uniformly.
inline float mixPositionWheels(float linear[4], const float yaw[4], float max_rpm) {
  float scale = 1.0f;
  for (int i = 0; i < 4; ++i) {
    if (linear[i] > 0.0f) scale = fminf(scale, (max_rpm - yaw[i]) / linear[i]);
    if (linear[i] < 0.0f) scale = fminf(scale, (-max_rpm - yaw[i]) / linear[i]);
  }
  scale = fmaxf(0.0f, scale);
  for (int i = 0; i < 4; ++i) linear[i] = linear[i] * scale + yaw[i];
  return scale;
}
