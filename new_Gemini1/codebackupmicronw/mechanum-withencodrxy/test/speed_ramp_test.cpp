#include "speed_ramp.h"
#include <assert.h>
int main() {
  assert(rampWheelSetpoint(0, 500, .02f) == 5);
  assert(rampWheelSetpoint(500, -500, .02f) == 495);
  assert(rampWheelSetpoint(-500, 0, .02f) == -495);
  assert(rampWheelSetpoint(0, 3, .02f) == 3);
  assert(rampWheelSetpoint(10, 500, 0) == 10);
}
