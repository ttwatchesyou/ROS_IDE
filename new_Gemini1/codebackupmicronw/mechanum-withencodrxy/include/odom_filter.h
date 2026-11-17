#pragma once

#include <math.h>

// A scalar Kalman estimator on accepted *absolute* odometry position.
// Filtering absolute position avoids integrating a lagged velocity and
// inventing extra travel after the wheels stop.
struct PositionKalman {
  float estimate = 0.0f;
  float variance = 0.00001f;

  void reset() { estimate = 0.0f; variance = 0.00001f; }

  float update(float measurement, float dt) {
    constexpr float process_variance_per_second = 0.005f;
    constexpr float measurement_variance = 0.00001f;
    variance += process_variance_per_second * dt;
    const float gain = variance / (variance + measurement_variance);
    estimate += gain * (measurement - estimate);
    variance *= 1.0f - gain;
    return estimate;
  }
};

// A Kalman filter alone cannot reject a metre-scale pulse burst: it would
// eventually follow the false measurement. Reject physically impossible
// displacement *before* updating the raw-position measurement.
inline bool odomDeltaPlausible(long delta_ticks, float metres_per_tick, float dt) {
  // 500 RPM on a 5-inch drive wheel is about 3.33 m/s. Allow that speed
  // without treating valid passive-odometry counts as an outlier.
  constexpr float max_odom_speed_mps = 3.6f;
  const float safe_dt = dt > 0.001f ? dt : 0.001f;
  return fabsf(delta_ticks * metres_per_tick) <= max_odom_speed_mps * safe_dt;
}

struct OdomRateGate {
  float previous_velocity_mps = 0.0f;

  void reset() { previous_velocity_mps = 0.0f; }

  bool accept(long delta_ticks, float metres_per_tick, float dt) {
    if (!odomDeltaPlausible(delta_ticks, metres_per_tick, dt)) return false;
    const float safe_dt = dt > 0.001f ? dt : 0.001f;
    const float velocity_mps = delta_ticks * metres_per_tick / safe_dt;
    // The drive-wheel setpoint ramp limits physical acceleration to much
    // less than this.  The 0.2 m/s allowance covers encoder quantisation.
    constexpr float max_acceleration_mps2 = 20.0f;
    if (fabsf(velocity_mps - previous_velocity_mps) >
        0.2f + max_acceleration_mps2 * safe_dt) return false;
    previous_velocity_mps = velocity_mps;
    return true;
  }
};
