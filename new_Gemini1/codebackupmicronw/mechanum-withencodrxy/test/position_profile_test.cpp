#include "position_profile.h"
#include <assert.h>
#include <stdio.h>

int main() {
  AxisPid pid;
  pid.output_limit_mps = 3.3f;
  pid.kp = 6; pid.kd = 5;
  pid.resetMeasurement(0);
  assert(fabsf(pid.output(1, .02f) - 3.3f) < .001f);
  assert(fabsf(pid.output(-1, .02f) + 3.3f) < .001f);
  // Goal changes do not inject D; real forward velocity produces damping.
  pid.kp = 0;
  assert(pid.output(100, .02f) == 0);
  pid.observe(.02f, .02f);
  assert(pid.output(0, .02f) < 0);
  pid.kp = 20; pid.ki = 2; pid.kd = 0; pid.integral = 0;
  for (int i = 0; i < 500; ++i) pid.output(10, .02f);
  assert(pid.integral == 0);
  pid.kp = 0; pid.ki = 1; pid.integral = 1;
  pid.output(-.1f, .02f, false);
  assert(pid.integral < 1); // a downstream limit must still allow unwinding

  float x = 0, y = 0;
  for (int i = 0; i < 25; ++i) rampPositionVector(x, y, 1.2f, 1.6f, 2, .02f);
  assert(fabsf(x - 1.2f) < .001f && fabsf(y - 1.6f) < .001f);
  for (int i = 0; i < 25; ++i) rampPositionVector(x, y, 0, 0, 2, .02f);
  assert(hypotf(x, y) < .001f);
  float wheels[4] = {500, 500, 500, 500};
  const float yaw[4] = {-100, 100, -100, 100};
  assert(fabsf(mixPositionWheels(wheels, yaw, 500) - .8f) < .001f);
  assert(wheels[0] == 300 && wheels[1] == 500);
  for (int turn = -500; turn <= 500; turn += 100) {
    for (int translation = -1000; translation <= 1000; translation += 100) {
      float mixed[4] = {float(translation), float(-translation), float(translation), float(-translation)};
      const float rotation[4] = {-float(turn), float(turn), -float(turn), float(turn)};
      const float factor = mixPositionWheels(mixed, rotation, 500);
      assert(factor >= 0 && factor <= 1);
      for (float value : mixed) assert(fabsf(value) <= 500.001f);
    }
  }

  // Simplified lagged plant: convergence in both directions, no claim of
  // matching the physical robot. Includes a mid-run goal change.
  AxisPid servo;
  servo.kp = 3; servo.kd = .4f; servo.output_limit_mps = 2;
  servo.resetMeasurement(0);
  float position = 0, velocity = 0, command = 0, unused = 0;
  float peak = 0;
  for (int i = 0; i < 1000; ++i) {
    servo.observe(position, .02f);
    const float goal = i < 500 ? 1.0f : -1.0f;
    const float requested = servo.output(goal - position, .02f);
    rampPositionVector(command, unused, requested, 0, 2, .02f);
    velocity += .02f / .08f * (command - velocity);
    position += velocity * .02f;
    peak = fmaxf(peak, fabsf(velocity));
    assert(isfinite(position) && fabsf(command) <= 2.001f);
    if (i == 499) assert(fabsf(position - 1) < .01f);
  }
  assert(fabsf(position + 1) < .01f);
  printf("Position controller checks passed; simulated peak %.3f m/s\n", peak);
}
