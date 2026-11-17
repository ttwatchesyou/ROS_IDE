#include <assert.h>
#include <math.h>
#include "odom_filter.h"

int main() {
  constexpr float metres_per_tick = 2.0f * 3.14159265358979323846f * 0.029f / 600.0f;
  assert(odomDeltaPlausible(100, metres_per_tick, 0.02f));
  assert(odomDeltaPlausible(-100, metres_per_tick, 0.02f));
  assert(odomDeltaPlausible(217, metres_per_tick, 0.02f));
  assert(!odomDeltaPlausible(500, metres_per_tick, 0.02f));
  assert(!odomDeltaPlausible(-500, metres_per_tick, 0.02f));

  OdomRateGate gate;
  assert(gate.accept(0, metres_per_tick, 0.02f));
  assert(gate.accept(2, metres_per_tick, 0.02f));
  assert(!gate.accept(100, metres_per_tick, 0.02f));
  assert(gate.accept(3, metres_per_tick, 0.02f));
  gate.reset();
  for (long ticks = 0; ticks <= 132; ticks += 2) {
    assert(gate.accept(ticks, metres_per_tick, 0.02f));
  }

  PositionKalman filter;
  for (int i = 0; i < 10; ++i) assert(filter.update(0.0f, 0.02f) == 0.0f);
  const float first_step = filter.update(0.1f, 0.02f);
  assert(first_step > 0.0f && first_step < 0.1f);
  for (int i = 0; i < 100; ++i) filter.update(0.1f, 0.02f);
  assert(fabsf(filter.estimate - 0.1f) < 0.0001f);

  float accepted_position = 0.1f;
  const long burst_ticks = 1100;  // roughly the observed 33 cm / 50 ms burst
  if (odomDeltaPlausible(burst_ticks, metres_per_tick, 0.05f)) {
    accepted_position += burst_ticks * metres_per_tick;
  }
  filter.update(accepted_position, 0.02f);
  assert(fabsf(filter.estimate - 0.1f) < 0.0001f);

  filter.reset();
  assert(filter.estimate == 0.0f);
  return 0;
}
