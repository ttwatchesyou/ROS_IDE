#include <cassert>
#include <cmath>
#include "../include/yaw_profiles.h"

int main() {
  assert(findYawProfile(NAN) == nullptr);
  assert(findYawProfile(INFINITY) == nullptr);
  assert(findYawProfile(-1.0f) == nullptr);
  assert(findYawProfile(0.0f) == nullptr);
  assert(findYawProfile(1.25f) == nullptr); // no untested interpolation
  for (const auto &profile : YAW_PROFILES) {
    const auto *selected = findYawProfile(profile.speed_radps);
    assert((selected != nullptr) == profile.validated);
    if (selected) {
      assert(selected == &profile);
      assert(std::isfinite(selected->kp) && selected->kp > 0);
      assert(std::isfinite(selected->kd) && selected->kd >= 0);
    }
  }
}
