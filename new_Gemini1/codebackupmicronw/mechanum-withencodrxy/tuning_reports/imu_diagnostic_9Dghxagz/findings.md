# Passive capture findings — 2026-09-26, Asia/Bangkok

No motor commands, resets, connection changes or firmware edits were issued by this observer.
Source: passive_capture.jsonl (GET backend state every ~250 ms). Backend latest_line is decoded text, not lossless raw serial. GPIO voltages, driver current and reset cause are not measured.

Latest trial:
- 19:04:59.179: goal active, mask 15; goal X=2 m, Y=-1 m, yaw=2.0354 rad; IMU ready.
- 19:05:11.000: IMU ready; PWM [-150.9,-105.9,-255,4.9], RPM [6.31,28.21,34.46,-0.08].
- 19:05:12.282: IMU still ready and telemetry fresh; wheel speeds nearly zero while PWM [-174.4,-254.7,-255,24].
- 19:05:12.587–12.890: reported wheel RPM all zero despite nonzero output demand. Last valid telemetry ms=38886, PWM [-189.6,-255,-255,28.9]. Pose X=1.6681 m, Y=-0.794 m, yaw=1.8994 rad; goal still active.
- 19:05:13.196: both freshness flags false. Last decoded line contains control bytes: T:TARGET:389368-65\u0000308C\u0000\u0000\u0001\u0000.
- Backend HTTP command endpoint subsequently returned a 504 at 19:05:14; journal does not include request bodies, so the command cannot be identified from this entry alone.
- No USB disconnect/reset event found in inspected kernel journal window.

Earlier trial also ended with malformed serial text and both streams stale at 19:03:56. Board uptime subsequently restarted before 19:04:35; capture cannot identify whether manual reset or power interruption caused this restart.

Interpretation: latest event is not demonstrated to be an isolated IMU dropout. Wheel feedback drops near zero BEFORE whole-stream corruption/staleness, while last valid IMU flag remains true. PWM is firmware demand, not measured driver output/current. Motor power/driver protection, mechanical or feedback problems, MCU faults, and serial link corruption remain possible; present evidence does not establish a root cause or prove a spontaneous MCU reset. Do not infer present motor output from stale PWM.

Next evidence needed: whether operator cut motor power before stream loss, driver status LEDs/voltage at that instant, and instrumented MCU reset cause / IMU reset count / raw serial capture. Keep drive power off while diagnosing stale control telemetry.
