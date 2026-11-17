#pragma once

// User-measured drive wheel outside diameter: 5 in = 127 mm. Keep this
// separate from the 29 mm passive odometry-wheel radius.
constexpr float DRIVE_WHEEL_DIAMETER_M = 5.0f * 0.0254f;
constexpr float DRIVE_WHEEL_RADIUS_M = DRIVE_WHEEL_DIAMETER_M * 0.5f;

// The independent manual power test uses 3 m/s as the scale label for PWM255.
// This is not a speed limit for XY position commands or a measured speed.
constexpr float OPEN_LOOP_FULL_PWM_REQUEST_MPS = 3.0f;
