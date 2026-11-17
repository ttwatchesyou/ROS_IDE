# Position controller v6

Firmware banner: `T:FW:world-xy-pid-hold-20khz-v6`.

- GOAL activates world-frame X/Y PID and the commanded yaw together. No motor
  is armed at boot. Repeated identical GOAL heartbeats do not reset the loop.
- Axis command: `Kp * position_error + Ki * integral - Kd * measured_velocity`.
  Gains still use `T:POS_PID_X/Y`; goal or gain changes do not inject a D kick.
- The old hard-coded 0.25 m/s² distance limiter is removed. PID output is
  bounded by POS_SPEED and the 500-RPM wheel ceiling. This is a more aggressive
  controller: old saved gains are not validated for it.
- One shared world-XY vector ramp reaches the configured XY speed in 0.5 s
  when PID requests that speed. Deceleration has the same rate. There is no
  second 250-RPM/s ramp in GOAL; manual wheel/twist still uses that ramp.
- Yaw has first use of available wheel speed; XY is scaled uniformly if needed.
- Position and velocity must both settle (1 cm, 0.02 m/s, yaw 0.015 rad,
  yaw rate 0.03 rad/s for 150 ms) before GOAL_REACHED. Hold stays active and
  responds to drift. STOP releases hold and zeros PWM; command timeout remains.
- GOAL refuses stale IMU data, and an IMU gap over 250 ms stops active GOAL.
- Anti-windup handles position output/ramp limits and wheel PWM saturation.
- PWM remains 20 kHz / 0–255. Wiring and encoder directions are unchanged.

The new `T:TARGET:ms:FL:FR:RL:RR` frame carries wheel RPM setpoints. Existing
TEL/POSE frames remain compatible. The updated RobotTuner backend joins fresh
targets to telemetry; graphs draw targets dashed and measured RPM solid.

Verification: host controller tests include saturation, anti-windup, derivative
response, reversal, shared ramp and yaw priority; a lagged simulated plant
converges after retargeting. These are software checks, not physical tuning or
a guarantee of zero overshoot. Maximum loaded speed and stopping distance
still require measurement. Changing P cannot raise speed above configured
limits; D provides damping, and excessive D amplifies velocity noise.

Cleanup: removed obsolete braking envelope and duplicate position wheel-ramp
branch; moved position PID into position_profile.h; consolidated duplicated
omni geometry into omni_kinematics.h. Manual test modes remain used by the UI.

Handoff: firmware binary built successfully, but not flashed or physically
tested. Frontend production build verified separately at
`/tmp/robot-tuner-v6-build.vRTIVe` so the running site's assets were not replaced.
Backend TARGET parsing and frontend target curves are source changes awaiting
service deployment together. The old backend can still read v6 TEL/POSE.
