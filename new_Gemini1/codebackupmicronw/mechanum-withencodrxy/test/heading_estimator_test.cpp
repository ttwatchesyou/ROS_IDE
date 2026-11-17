#include "heading_estimator.h"
#include <assert.h>
int main() {
  float yaw = 0;
  for (int i = 0; i < 100; ++i) yaw = estimateHeading(yaw, .01f, false, 0, .02f);
  assert(fabsf(yaw - 1) < .0001f); // continues turning with missing IMU
  float recovered = estimateHeading(yaw, 0, true, 0, .02f);
  assert(fabsf(recovered - yaw) <= .04001f); // no recovery jump
  for (int i = 0; i < 100; ++i) recovered = estimateHeading(recovered, 0, true, 0, .02f);
  assert(fabsf(recovered) < .0001f);
  const float wrapped = estimateHeading(3.13f, .03f, false, 0, .02f);
  assert(wrapped < -3.1f && wrapped > -3.15f);
  assert(fabsf(headingWrap(estimateHeading(3.13f, 0, true, -3.13f, .02f) - 3.13f)) < .04f);
}
