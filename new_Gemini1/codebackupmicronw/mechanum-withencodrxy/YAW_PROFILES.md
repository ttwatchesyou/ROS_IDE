# Yaw rotation profiles (loaded robot, 0° → 90° → 0°)

The following values are in `include/yaw_profiles.h`. They are for the
existing yaw **PD** controller; it has no integral term, so Ki is 0 for all
profiles. Wheel PID and encoder pin definitions were not changed in this
work. Angular speed is a **command ceiling**, not a guarantee that the robot
will reach that speed over a 90° movement.

| Command ceiling (rad/s) | Kp | Ki | Kd | Worst tested cycle (s) | Peak measured yaw speed (rad/s) |
|---:|---:|---:|---:|---:|---:|
| 0.5 | 4.0 | 0 | 0.4 | 12.84 | 0.48 |
| 1.0 | 4.4 | 0 | 0.4 | 11.32 | 0.99 |
| 1.5 | 4.8 | 0 | 0.5 | 10.26 | 1.83 |
| 2.0 | 4.0 | 0 | 1.2 | 12.04 | 2.10 |
| 2.5 | 4.0 | 0 | 1.6 | 12.18 | 2.33 |
| 3.0 | 4.8 | 0 | 1.8 | 10.87 | 2.32 |

Each selected setting was tested on the currently flashed board three times,
in both directions. No overshoot was measured during those selected runs.
Settling times include one second of steady observation. Earlier rejected
candidate trials did overshoot, including a 2.5 rad/s trial that crossed 91°.
This is empirical performance for the tested load, not a zero-overshoot
guarantee under every load or battery condition.

**Firmware mismatch to resolve:** the board used for these measurements still
had the earlier `yaw-presets-exti-v1` firmware. After the user requested the
previous encoder code back, the source was restored to the previous encoder
implementation. These candidate gains therefore have `validated=false` in
the source table. The source rejects `T:YAW_PROFILE:<speed>` until the
corresponding speeds have been retested after uploading this restored source.
Do not flip the flags merely because the board's earlier trials passed.

After the source and hardware are aligned and revalidated, set each passing
entry's `validated` flag to `true`, rebuild and upload. Recall a profile with:

```text
T:YAW_PROFILE:1.0
T:GOAL:<current_x>:<current_y>:1.570796
```

While profile mode is active, `T:POS_SPEED:<linear>:<angular>` also selects the
matching validated yaw profile. `T:YAW_PID:<kp>:<kd>:<max>` returns to manual
PID for tuning. Keep sending goal heartbeats under the existing one-second
firmware timeout, then send `T:STOP`.

Test evidence: `tuning_reports/profiles_20260924_125422/profiles.json`,
`profiles.csv`, and `yaw_profiles.png`; raw time-series data remain in the
referenced `yaw_web_*` directories.
