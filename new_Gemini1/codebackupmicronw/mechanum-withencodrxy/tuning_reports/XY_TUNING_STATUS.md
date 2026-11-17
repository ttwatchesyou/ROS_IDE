# XY position/yaw tuning — 2026-09-24

Status: **limited-speed XY defaults tested; further tuning paused pending an
unexplained post-stop odometry shift**.
The earlier collision/emergency stop prompted a `T:STOP` and `T:POSE_RESET`.
The new current-position origin was X=0, Y=0. After the user released the
emergency stop, trials resumed with a shorter distance first.

The following gains are source-code defaults in `src/main.cpp` (build passed).
The user reports uploading the new firmware; subsequent trials were run with
`--firmware-defaults`, which does not send PID/speed overrides:

| Controller | Kp | Ki | Kd |
| --- | ---: | ---: | ---: |
| X position | 2.0 | 0 | 0.1 |
| Y position | 2.0 | 0 | 0.1 |
| Yaw heading | 9.5 | — | 0.4 |

The source default position speed limit is 0.35 m/s, yaw command limit
1.5 rad/s. Tests of ±0.8 m and return along each of X and Y at a 0.35 m/s
command with X/Y gains 2/0/0.1 showed **no odometry overshoot**. Final
XY error over the eight legs was 0.7–1.9 cm; transient yaw error was at
most 2.7°. These results use onboard odometry and IMU, not external
ground-truth measurement. The yaw angle was deliberately held at an absolute
0 rad in every trial. The 0.8 m test margin is intentional because the
physical workspace is limited to ±1 m.

The same X/Y gains at a 0.5 m/s command for a 0.5 m X move produced about
0.4–0.5 cm overshoot, but transient yaw error reached 4.8°. A 1.0 m/s
command had previously tripped the 8° yaw limit; neither 1.0 nor 2.0 m/s
is approved by these tests. Short 0.2 m moves are slow with these gains;
3/0/0.1 was faster in a short trial, but its 0.5 m trial overshot by
1–1.6 cm, so it was not selected as the global default.

New successful reports: `xy_20260924_135137_249183/`,
`xy_20260924_135151_764735/`, `xy_20260924_135212_960340/`,
`xy_20260924_135225_411047/`.

## After the reported upload

At the 0.35 m/s firmware-default command, +X 0.8 m and return completed
in ~3.4 s per leg, with no odometry overshoot and final error 1.7–2.2 cm.
+Y 0.8 m had no overshoot and final error 2.4–2.9 cm, but one outbound leg
took 10.3 s because X/Y/yaw hovered near the settle thresholds. A −X 0.8 m
outbound leg was normal; its return showed 3.7 cm apparent overshoot and a
single X odometry jump of 5.5 cm in 50 ms after X had been stationary for
~0.25 s. The user observed smooth physical motion without a collision or
touch. The resulting 1.1 m/s *differentiated-odometry* peak should not be
treated as verified physical speed. A subsequent −Y 0.5 m test had no
overshoot, but its last recorded Y=0.0901 m became Y=0.1928 m after STOP
without any user touch (10.3 cm difference). PWM reported zero. A later
20-second stationary observation (187 API samples) found zero further
X/Y drift. This points to a motion/stop-associated odometry or mechanical
effect, not proven continuous idle noise. Its exact cause is unresolved;
further high-speed/long-distance tuning is paused. The trial tool now
checks for >3 cm pose shift in the 1.5 seconds after every STOP. The
wheel/encoder configuration was not changed.

After the user checked the mechanical setup, a cautious Y 0.2 m / 0.25 m/s
trial (`xy_20260924_141315_266951/`) had <1 mm post-STOP drift on both
legs. However, during the return the X pose again jumped 4.19 cm in one
50 ms sample while the commanded motion was along Y. This independently
reproduces a movement-associated X odometry anomaly even at low speed.

Read-only source/core inspection found an additional concrete problem:
the FR wheel encoder interrupt is attached to PA0, then odometry X is
attached to PB0. STM32F103 GPIO EXTI line 0 cannot select both ports at
once; the installed STM32 Arduino core indexes its interrupt callback by
pin number and the later PB0 attachment replaces PA0's callback. This
explains why the project currently flags FR encoder unavailable/open-loop,
which can make yaw correction uneven. It does **not by itself prove** the
cause of the X pose jumps. Encoder code was left unchanged; the user
subsequently directed that it remain exactly as-is.

A further X 0.2 m trial with P=2.5, I=0, D=0.1 was contaminated by a Y
jump of 4.28 cm in 50 ms and is not valid for tuning. The trial tool now
rejects such within-motion cross-axis jumps when selecting gains. A later
X 0.2 m trial with P=3, I=0, D=0.1 had no detected pose jump and
reached/returned in 2.58/2.32 s without measured overshoot; post-STOP
drift was <1 cm. The pose X baseline changed by ~43 cm between these
trials while no test command was running; the user confirmed the robot was
not manually repositioned. No STM32 encoder, pin, or PID-default code was
changed after the upload.

## Airborne isolation test

With the robot secured and all drive/odometry wheels airborne, a supervised
individual-wheel test at 50 and 100 RPM showed FL/RL/RR wheel feedback near
target while the odometry X/Y positions stayed exactly unchanged. FR had
about 40/69 PWM respectively but still zero encoder ticks, consistent with
the known open-loop FR configuration. The initial attempted test had zero
PWM on every wheel and is invalid; the tool now rejects that condition.
Valid raw logs: `airborne_20260924_143524.json` and
`airborne_20260924_143603.json`. This rules out reproducible odometry noise
from free-running drive motors at 50–100 RPM, but not load-dependent
vibration, sensor-wheel contact/slip, or intermittent wiring on the floor.

An airborne hand test with PWM=0 turned only the passive X measuring wheel
one marked revolution forward, then one marked revolution back. Relative
robot-frame X pose changed about +25.6 cm forward and −21.0 cm backward,
leaving ~4.6 cm residual despite returning the wheel mark. The configured
29 mm radius and 600 ticks/rev predict 18.2 cm per wheel revolution.
The ~3 cm world-frame Y change on the first turn is explained by the
robot's approximately −6.9° yaw rotation of robot-frame X into world Y;
it does not alone prove Y encoder cross-talk. The X trace was smooth, not
one isolated pulse spike. Exact manual-turn accuracy and mechanical coupling
remain possible factors, so this is diagnostic evidence rather than a
new encoder calibration. The user explicitly declined encoder-code changes.

With PWM=0, one marked revolution of only the passive Y measuring wheel
changed robot-frame Y by about −19.2 cm. The configured 29 mm radius and
600 ticks/rev predict 18.2 cm, a difference of about 5.5%. The simultaneous
world-frame X shift of about −2.2 cm is consistent with the measured yaw
of approximately −0.112 rad; it does not establish X encoder cross-talk.
This is one manual revolution, so repeatability still needs a reverse-turn
check before treating it as calibration evidence.

The user then turned Y back one marked revolution with motors stopped.
Robot-frame return motion was about +18.7 cm, leaving approximately
0.5–0.6 cm Y residual relative to the original baseline. Telemetry PWM
remained zero, position control inactive, and IMU available. Unlike the
earlier X forward/back result (~4.6 cm residual), this Y pair was reasonably
repeatable, although hand rotation is not a precision calibration.

A second manual X forward revolution, from world pose (−0.2191, 0.2033)
to (−0.0341, 0.1826) at yaw −0.1112 rad, measured about +18.6 cm in
robot-frame X. This is near the predicted 18.2 cm and contrasts with the
earlier +25.6 cm reading. PWM was zero.

The second X reverse turn returned from (−0.0341, 0.1826) to
(−0.2152, 0.2028), about −18.2 cm robot-frame X. The round-trip residual
against (−0.2191, 0.2033) is only about +0.4 cm X. This second X pair is
reasonably repeatable, so the first X pair alone does not establish a
systematic encoder-scale fault. The on-floor odometry discontinuities and
drift still need a separate low-speed contact/load check before loaded
position PID tuning can be trusted. PWM stayed zero throughout.

After the user returned the robot to the floor and confirmed readiness,
a bounded +X 0.10 m out-and-back diagnostic was attempted at a 0.15 m/s
linear command. The outbound leg alone timed out after 20 s; no return
leg was commanded. From (−0.2217, 0.1989) at yaw 0.0265 rad, the final
measured pose was about (−0.1094, 0.1675) at yaw 0.0114 rad. Thus X
overshot the +0.10 m goal by ~1.2 cm while Y shifted ~−3.1 cm. The
3 cm combined-position settle threshold was not met. Maximum individual
50 ms pose steps were ~1.12 cm X and ~0.19 cm Y; no >4 cm jump in this
trial. The script issued STOP, PWM returned to zero, and position control
was inactive. Log: `xy_20260924_144806_615780/`. Physical observed
motion and cause of cross-axis drift remain to be verified before
selecting new position PID gains.

The user observed that the chassis did **not physically translate** during
this 0.10 m trial, despite the reported +0.112 m X / −0.031 m Y pose
change. Motor encoder totals changed from [2815, 1, 95792, 922] just
before the run to [3017, 1, 96074, 1030] after STOP, so at least three
drive-wheel encoders registered motion; FR encoder remained unavailable.
The odometry pose therefore cannot be treated as ground-truth robot motion
in this condition. Do not resume loaded position PID sweeps until wheel
contact, drive-wheel rotation, passive odometry-wheel rotation, and power
state are physically checked. No encoder firmware changes were made.

At the user's request, one further bounded open-loop-style `TWIST` forward
command was issued at vx=0.2 m/s, vy=wz=0 for ~0.7 s; `STOP` was sent in a
finally block. During the command, all four software PWM values were
nonzero (~54, 46, 62, 94) but measured FL/RL/RR RPM was only about 9/4/5;
FR reported 0 as expected with its unavailable encoder. Pose changed
roughly +2.8 cm X and −1.6 cm Y; physical wheel/chassis movement awaits
user confirmation. After STOP, PWM was [0,0,0,0]. RR encoder total was
1030 in an earlier snapshot and −9296 in the pre-trial snapshot, but the
intervening period was not continuously monitored, so the cause and timing
of this counter shift are unknown. No further motion is planned until the
physical drive-wheel behavior and motor supply are clarified.

After the user confirmed all wheels airborne and robot secured, each
drive wheel was commanded individually at 100 RPM for 1 s, with STOP
between wheels (`airborne_20260924_145519.json`). FL/RL/RR reported
~102–104 RPM peaks and ~1109–1129 encoder ticks each; FR reported zero
ticks/RPM despite ~69 PWM, consistent with the previously unavailable FR
encoder. X/Y passive-wheel pose remained stable within 1.5 mm. Final
PWM/RPM were zero and position control inactive. Visual confirmation of
which physical wheels rotated is still needed before attributing the
on-floor no-translation report to traction/load/power or a wiring issue.
The user visually confirmed that all four wheels rotated as commanded
in this airborne test. This validates unloaded actuation but not loaded
torque, traction, or chassis motion. The preceding 0.2 m/s ground twist
corresponds to only about 48 RPM per wheel for the configured 40 mm drive
radius; a higher but tightly time-bounded loaded wheel-speed check would
help distinguish static-friction/voltage sag from a control-command issue.

After the user lowered the robot and confirmed readiness, all four wheels
were selected and commanded to +100 RPM in a roughly half-second bounded
trial (START then STOP, no position goal). Board baseline was reset to pose
(0,0) and wheel ticks [0,0,0,0] before the trial. During drive, reported
PWM was [129.7,69.4,140.3,142.8], RPM [19.1,0,14.5,5.8], and ticks
[35,0,32,11]. After STOP, PWM was zero and ticks [111,0,83,45]; later
pose settled near (0.0707,−0.0245), but this is not confirmed physical
motion. A 250 RPM/s command ramp means a short pulse is insufficient to
judge steady-state 100 RPM tracking. Physical wheel/chassis observation
is needed before interpreting loaded torque or continuing tuning.
The user visually confirmed that the chassis moved a little during this
short loaded 100 RPM trial; direction/heading of that motion was not yet
confirmed. Thus the earlier no-motion report at a 0.2 m/s (~48 RPM)
command may reflect insufficient breakaway effort, but this is not yet
proven because the duration and control mode also differed.
The user then described the physical movement as forward diagonally to
the right. This agrees in sign with the final odometry (+7.1 cm X,
−2.5 cm Y) and slight clockwise yaw (~−1.4°), but does not yet identify
the offending wheel. With a pure +X command, `omniTwistToRpm()` requests
equal positive wheel RPM. During the short loaded pulse, FL/RL/RR measured
speed was unequal and FR remained unmeasured/open-loop. Inference:
load-dependent wheel-speed/traction imbalance is plausible; do not alter
wheel inversion or position PID from this one short observation.

At the user's request to continue with the confirmed 45° X layout, a
bounded all-wheel +100 RPM ground run was attempted. No position goal
was used. Baseline pose (0.0707,−0.0245), yaw −0.073 rad, PWM zero.
The source's 250 RPM/s setpoint ramp brought measured FL/RL/RR RPM to
about 78/55/54 by 0.93 s; FR still had no encoder speed reading and
received ~69 PWM while the other channels received ~90–119 PWM.
The safety monitor tripped at ~1.04 s on >15 cm lateral *reported*
drift. The firmware watchdog had already zeroed PWM at about 1 s, and
an explicit STOP was also sent. Post-stop pose stabilized near
(0.4457,−0.2154), yaw −0.3109 rad, with PWM/RPM all zero. That is
~+37.5 cm X, −19.1 cm Y and ~−13.6° yaw relative to start—far too much
heading/lateral deviation to continue a speed or position PID sweep.
Physical motion/clearance must be confirmed with the user. This test
did not change firmware or encoder configuration.
The user confirmed the chassis physically deviated/rotated during this
run, without cable tension or collision. The run therefore reflects a
real loaded steering/balance problem, not just a display artifact.

A later stationary-command snapshot showed pose (0.5524, 0.1165), yaw
−0.3108 with drive encoder totals unchanged at [717,0,511,413] and
PWM/RPM zero. Relative to the earlier stopped snapshot (0.4457,−0.2154),
the passive odometry pose shifted +10.7 cm X and +33.2 cm Y over an
unmonitored interval; whether the user physically repositioned the robot
then is unknown. Do not classify this as an encoder fault until that
question is answered.
The user stated they did not push or reposition the robot after STOP,
though the chassis moved slightly on its own. That small observed motion
does not account for the +10.7/+33.2 cm pose change with three available
drive encoders unchanged. A later ~6 s read-only idle watch at board time
743–749 s found X/Y exactly stable, yaw varied <0.001 rad, PWM zero, and
drive ticks unchanged. Thus the discrepancy is intermittent rather than
continuous in that window. Passive measuring wheels spinning/slipping,
intermittent encoder signals, or unobserved coasting remain possibilities;
no PID values should be selected from this interval.

With motor-drive power switched off but STM32/USB telemetry still active,
an idle baseline over ~5 s was exactly steady at world pose
(0.5695,0.1729), yaw −0.3108, drive ticks [717,0,511,413], PWM zero.
The user then gently moved the *identified X measuring-wheel cable*
without intentionally turning a wheel or moving the chassis. The subsequent
pose was (0.6189,0.3267), yaw −0.3106; drive ticks and PWM were unchanged.
The world-frame displacement (+4.94 cm,+15.38 cm), rotated into the
robot frame using the stable yaw, is approximately (0.0 cm X,+16.2 cm Y),
or ~533 configured passive-Y encoder ticks. Thus this manipulation
triggered a Y-channel-like odometry change, not an X-channel-like one.
Possible X/Y harness misidentification, shared connector coupling, or
intermittent Y encoder input must be isolated physically; do not change
pin mappings or PID based on one cable-touch event.
The user next gently moved only the Y measuring-wheel cable. Pose remained
exactly (0.6189,0.3267) at yaw −0.3106; PWM and drive ticks stayed zero.
Therefore the repeatable observation so far is an apparent Y odometry
change during the *X-cable* handling but not Y-cable handling. Since manual
rotation of the actual X wheel earlier produced X-axis pose correctly,
this does not justify swapping X/Y in firmware. A shared harness or loose
Y signal/ground connection disturbed when X cable is moved is more
plausible, but not yet confirmed.
The user then moved only the X cable segment near the X sensor, avoiding
the Y cable and shared bundle. Pose stayed exactly (0.6189,0.3267),
PWM/ticks zero/unchanged, and yaw moved only ~0.0006 rad. This narrows the
earlier Y-like odometry burst toward the shared harness/board-end movement
or a coincident intermittent event, rather than the isolated X sensor-end
cable segment. Inspect/reseat board-side Y encoder A/B and common ground
with power safely removed before further loaded motion.

Despite the unresolved hardware/feedback concerns, the user explicitly
requested another approximate bounded tuning step and re-enabled power.
STM32 telemetry was verified fresh with PWM zero. A single all-wheel
75 RPM / 0.55 s ground pulse via `tools/bounded_ground_speed_check.py`
completed without its in-pulse guard tripping; report
`ground_speed_20260924_161525.json`. Last in-pulse sample at 0.543 s:
pose (0.0454,−0.0197), yaw −0.0564, measured FL/FR/RL/RR RPM
[36.45,0,27.30,11.84] and PWM [84.8,54.5,98.4,107.8]. STOP set PWM
to zero. Shortly after, with position control inactive and PWM zero,
reported Y position jumped to about −1.736 m. Pose history shows several
Y steps of −0.12 to −0.33 m per 50 ms around board time 29.6–29.9 s,
with yaw constant at −0.1109 rad. This is an impossible odometry rate for
the bounded pulse and invalidates XY PID data. No further loaded motion
should be commanded until the passive Y encoder/harness problem is fixed.
The user reports the wiring is stationary and securely connected, so a
loose wire is **not established**. The backend raw last line is a board
`T:POSE` frame with the same Y jump; the dashboard did not create it.
The local firmware's `encoderOdomY()` counts every PB9 rising edge with
no edge-rate plausibility check or digital filter, and `updatePose()`
integrates every count. A 0.3345 m / 50 ms pose step corresponds to
about 1100 configured Y encoder ticks per 50 ms (~22 kHz), comparable
to the 20 kHz PWM timer frequency, but that frequency similarity alone
does **not** prove electrical coupling. Direct raw-count/pin diagnostics
would be needed to distinguish input noise, mechanical free-spinning,
or a firmware/state issue before any encoder-code change.

Firmware mitigation prepared but **not flashed**: `src/main.cpp` now
integrates accepted X/Y tick deltas into raw world pose, gates deltas
above 2.5 m/s or 20 m/s² plus quantisation allowance, then runs small
per-axis Kalman position estimators. The filtered `pose_x_m/pose_y_m` are
used by both on-board position control and `T:POSE`. An outlier during
motor activity invokes STOP and emits `T:ERR:ODOM_OUTLIER`. This does not
prove or repair the root cause of false pulses and cannot reject sustained
plausible-looking errors. No encoder pin mapping, ISR edge selection,
direction polarity, or wheel PID gain was changed. PlatformIO LTO reduced
Flash from 65,208/65,536 bytes to 59,732/65,536 after the filter; RAM is
5,948/20,480. Host filter tests and firmware build passed; physical
verification requires a controlled upload and supervised test.

At 0.5 m/s command over 0.5 m, yaw deviation is still roughly 3.5–5°.
An alternative yaw P=10, D=0.2 shortened a +Y 0.8 m trial, but did not
improve the heading error consistently, so the source retains P=9.5,
D=0.4. Firmware-default verification logs: `xy_20260924_140302_045393/`,
`xy_20260924_140325_143607/`, `xy_20260924_140338_429521/`,
`xy_20260924_140436_077178/`, `xy_20260924_140450_728547/`,
`xy_20260924_140621_603798/`, `xy_20260924_140738_176811/`.

Earlier trials with an absolute yaw target of 0 rad and commanded linear limit 0.35 m/s,
trials from the then-current location to ±0.5 m and back completed without
measured position overshoot. Typical final XY error was 1.5–2.2 cm; transient
yaw error reached about 2.2–3.0°. Some legs waited 7–12 s for yaw to enter
the 1° settle threshold. At a 0.5 m/s command over 0.5 m, final error was
roughly 0.3–1.3 cm, position overshoot up to 1.2 cm, and transient yaw error
up to 5.2°. At 1.0 m/s command, yaw exceeded the 8° safety threshold and the
test stopped. These are readings from the onboard odometry and IMU; no external
ground-truth position instrument was used.

The attempted 0.8 m test struck an obstacle. The user engaged the physical
emergency stop. No further movement was commanded. The trial tool now has a
0.8 m maximum target, 0.9 m telemetry trip, wrong-way and no-progress trips;
these are software backstops, **not substitutes for physical clearance and an
emergency stop**. The collision makes this run unsuitable for PID selection.
Its data are in `xy_20260924_133735_402789/`.

The robot has **not** been validated at ±1 m or 2 m/s. With the source's
40 mm drive-wheel radius and 400 RPM limit, the ideal straight-line wheel
speed limit is about 1.68 m/s before yaw correction or load. Therefore a
2 m/s command limit does not prove the robot can achieve 2 m/s. There is no
on-board firmware hash query, so the exact flashed binary cannot be
independently attested from the serial API. No encoder or wheel configuration
was changed during this XY trial.

## After onboard odometry-filter upload and battery replacement

The user reports uploading the firmware with the onboard X/Y position Kalman
and implausible-rate gate. Fresh telemetry showed IMU ready and all PWM=0.
Bounded 50 RPM/0.4 s and 75 RPM/0.45 s ground pulses completed without a
new odometry spike or safety fault; the latter still produced about 4.6°
clockwise heading drift, so filtering has not solved loaded steering balance.
Logs: `ground_speed_20260924_164537.json`,
`ground_speed_20260924_164558.json`.

After changing the battery, the user confirmed actual X/Y 10 cm travel and
return. At 0.20 m/s, P=3/I=0/D=0.1 was faster than P=2/I=0/D=0.1 in both
axes without measured overshoot. At 0.25 m/s, P=3 completed X and Y 20 cm
out-and-back with no measured overshoot, 1.5–2.8 cm final error per leg,
and at most 2.3° yaw error. The trial script stops once planar error stays
within 3 cm for 1 s; these results do **not** establish 1 cm precision or
performance near 2 m/s. The user confirmed real out-and-back motion but
observed the chassis lean/rotate. Source position defaults have been set to
P=3/I=0/D=0.1 for X and Y; yaw gains remain P=9.5/D=0.4. These new source
defaults require a further firmware upload before they take effect at boot.
Trials: `xy_20260924_164923_067323/`,
`xy_20260924_164947_447719/`, `xy_20260924_165010_101187/`,
`xy_20260924_165038_864691/`, `xy_20260924_165108_096781/`,
`xy_20260924_165126_000376/`.

The last Y trial's 164 logged samples had adjacent steps no larger than
0.78 cm X, 1.24 cm Y and 0.61° yaw, consistent with bounded moving-speed
readings rather than the earlier multi-decimetre odometry bursts. Thirty
idle API snapshots over 3.5 s showed no X/Y/yaw change at the serial
display precision and PWM remained zero. Its outbound yaw trace had only
two significant direction reversals, not rapid alternating jitter. The
BNO086 game-rotation vector is already fused internally. Adding another
Kalman layer to yaw angle without evidence of sensor noise would delay
heading feedback and cannot correct real physical steering drift; no extra
yaw filter was added. The existing onboard X/Y Kalman remains in place.

## Verification after the user uploaded the P=3 defaults

After the user reported an upload and confirmed BOOT0=0/reset and a clear
workspace, fresh STM32 telemetry had IMU ready and PWM=0. Trials with
`--firmware-defaults` did not send any PID or speed overrides. X and Y
10 cm out-and-back each completed without measured overshoot; peak yaw
error was about 2.1°. At 20 cm with the firmware's 0.35 m/s limit, X
out/return took 2.03/2.32 s, had no measured overshoot, and max yaw
error 2.61°. Y out/return took 2.04/2.15 s, with 0.59 cm return
overshoot and max yaw error 2.79°. These are onboard odometry/IMU
measurements, not independent physical ground truth. Logs:
`xy_20260924_170141_043863/`, `xy_20260924_170158_564405/`,
`xy_20260924_170219_793483/`, `xy_20260924_170233_129248/`.

An online yaw-gain comparison at the same X 20 cm/0.35 m/s test used
P=10/D=0.3. It worsened return overshoot to 1.84 cm and max yaw error
to 3.22°, so P=9.5/D=0.4 was restored on the running board and remains
the source default. Log: `xy_20260924_170254_886280/`. This trial also
sent X/Y position gains P=3/I=0/D=0.1 and speed limits 0.35 m/s,
1.5 rad/s; the only changed yaw gains were temporary. The physical
lean observed by the user is not resolved by this gain test. FR drive
wheel remains open-loop because its encoder feedback is unavailable;
loaded steering/traction cannot be inferred from PID graphs alone.

## Longer-distance and speed ramp after upload

At 0.35 m/s and firmware defaults, X and Y 0.40 m out-and-back completed
without measured overshoot. Peak yaw error was 3.11° X and 2.41° Y;
post-STOP pose drift was at most 1.5 mm. Logs:
`xy_20260924_170432_966252/`, `xy_20260924_170655_473904/`.

At 0.50 m/s, X +0.40 m with P=3/I=0/D=0.1 passed the target by
8.86 cm, then reversed over 5 cm before the safety script stopped it.
The user visually confirmed that the robot really overshot and reversed;
this was not merely a display spike. Log: `xy_20260924_170714_654066/`.
The trial script now stops at >4 cm target overshoot, before waiting for
the reversal detector. A lower-speed inward X −0.30 m trial at 0.40 m/s
with P=2.5/I=0/D=0.2 completed both legs without measured overshoot,
but the same gains at 0.50 m/s tripped the new 4 cm overshoot guard on
the first leg. Logs: `xy_20260924_170834_817546/`,
`xy_20260924_170852_714229/`. After STOP on the failed 0.50 m/s trial,
the reported position continued from roughly X=0.167 m to X=0.102 m
and yaw from +0.030 to −0.062 rad before becoming stable, with PWM=0.
Physical coasting/rotation after STOP awaits user confirmation. Do not
run further 0.50 m/s position trials or increase distance until that
behavior is understood. The running board was restored to X/Y P=3,
I=0, D=0.1 and linear limit 0.35 m/s, matching source defaults; PWM=0.

The user subsequently confirmed that the robot physically coasted/rotated
after STOP without collision. `stopAll()` writes zero PWM immediately;
the motor driver/brake-mode behavior is not established, so zero PWM must
not be described as an active brake. A **source-only, not uploaded**
position-speed envelope now limits commanded speed from remaining goal
distance whenever the requested linear limit exceeds the validated
0.35 m/s mode. It uses a conservative 0.35 m/s² deceleration assumption;
it leaves <=0.35 m/s behavior unchanged. This does not guarantee actual
braking or eliminate mechanical coasting. `test/position_profile_test.cpp`
and firmware build passed. Flash is 59,972/65,536 bytes (91.5%), RAM
5,948/20,480 (29.0%). No further motion should be attempted with the
new envelope until it is uploaded and reverified at low speed under
supervision; 0.5 m/s is **not validated**.

Per user instruction, the next source firmware also restores motor PWM
frequency to 54 kHz on both TIM1 (FL) and TIM4 (FR/RL/RR), replacing the
20 kHz setting in the currently tested build. Build and host profile test
pass. This frequency change is **not yet uploaded or physically verified**;
the motor feed-forward and PID response may differ at 54 kHz, so previous
performance numbers must be rechecked after upload before a high-speed
trial.

## After upload of the 54 kHz PWM and braking envelope

The user reported uploading the firmware and confirmed a clear workspace.
Board telemetry restarted, IMU was ready, PWM zero. X/Y 0.20 m trials at
the then-default 0.35 m/s completed without measured overshoot. X had up
to 1.27 cm post-STOP drift on one leg; Y remained within 0.3 cm.
Logs: `xy_20260924_171634_341004/`, `xy_20260924_171646_270024/`.

At 0.40 m/s with the braking envelope, X/Y 0.30 m trials completed
without measured overshoot. At a 0.50 m/s *commanded ceiling* and
0.30 m distance, X/Y also had no measured overshoot, but peak
differentiated-odometry speed was only about 0.43–0.46 m/s because the
envelope slowed early. One Y return leg drifted 2.43 cm in the 1.5 s
after STOP. The user confirmed actual travel matched the plots, including
the small post-STOP coast. Logs: `xy_20260924_171703_920169/`,
`xy_20260924_171717_550449/`, `xy_20260924_171734_149406/`,
`xy_20260924_171749_319827/`.

At a 0.50 m/s ceiling over 0.40 m, X overshot 1.87/2.43 cm out/return;
Y overshot 0/1.34 cm. Peak yaw error was about 4.9°. Thus 0.50 m/s does
not meet the no-overshoot/heading-quality target despite the profile.
At a 0.40 m/s ceiling over 0.40 m, X overshot only 0.10/0.22 cm and Y
0/0.21 cm (within odometry quantisation and much smaller than 0.50 m/s),
with max yaw error 3.71° and no material post-STOP drift. The user
confirmed real motion was normal. Logs: `xy_20260924_171829_481410/`,
`xy_20260924_171851_821149/`, `xy_20260924_171910_526472/`,
`xy_20260924_171926_147136/`.

The running board retains the 0.40 m/s online limit. Source defaults were
updated to 0.40 m/s for the next upload; X/Y P=3/I=0/D=0.1, yaw gains,
and the 54 kHz PWM frequency were not changed. Firmware build and the
position-profile host test passed. This source-default update has not
yet been uploaded. These data do not validate speeds above 0.40 m/s or
travel beyond 0.40 m.

## Re-check after uploading the 0.40 m/s default

The user reported uploading and confirmed supervised readiness. With
`--firmware-defaults` (no PID/speed override), X/Y 0.20 m out-and-back
had no measured overshoot. On the X 0.40 m return, however, the robot
physically overshot 1.55 cm and corrected back, taking 5.40 s; the user
confirmed the overshoot. This falsifies the earlier claim that the
0.40 m/s default is consistently no-overshoot. At a live reduced
0.35 m/s command, X 0.40 m return still physically overshot 0.99 cm.
Logs: `xy_20260924_172536_639896/`, `xy_20260924_172551_445511/`,
`xy_20260924_172609_548725/`, `xy_20260924_172736_686527/`.

The running board was set to a 0.35 m/s limit and stopped with PWM=0.
Source-only changes, **not yet uploaded**, restore the 0.35 m/s default
and apply the distance-based speed envelope at *all* speed settings with
a more conservative 0.25 m/s² deceleration assumption. X/Y PID gains,
wheel/encoder wiring, and 54 kHz PWM frequency are unchanged. Firmware
build and host profile test pass (Flash 59,964/65,536; RAM 5,948/20,480).
The new profile must be uploaded and physically retested before claiming
it solves the repeatability problem. No additional motion was commanded
after the repeated physical overshoot was confirmed.

## Verification after upload of the 0.25 m/s² envelope

The user reported uploading the all-speed braking envelope and confirmed
the supervised workspace. Fresh STM32 telemetry showed IMU ready and PWM
zero. With firmware defaults (0.35 m/s ceiling; X/Y P=3/I=0/D=0.1),
X/Y 0.20 m out-and-back did not overshoot on onboard odometry, though
some legs took 3.5–5.3 s. X/Y 0.40 m out-and-back were each repeated
twice with **zero reported overshoot** on all eight legs; X legs took
2.6–2.7 s, Y outbound took 5.6–7.3 s, and Y return took ~2.6 s.
Peak heading deviation was up to 4.35° on the last Y return. PWM was
zero after every trial. The user has not yet confirmed visual motion
for these latest runs, so this is not a claim of physical zero overshoot.
The user subsequently reported that the robot briefly ran over a cable
and has moved it clear. The exact leg of contact is unknown, so the last
Y result and its yaw/settling time must not be used for gain selection
until a cable-free repeat is observed. No collision with another object
was reported. PWM remained zero while waiting for the safe repeat.
After the user confirmed the cable was clear, a supervised Y 0.40 m
out-and-back with unchanged firmware defaults completed in 2.70/2.65 s,
zero measured overshoot, and max yaw error 2.69°. This is markedly
better than the cable-contact Y run (5.61/2.59 s; 4.35° yaw), consistent
with the obstruction affecting the previous result. The cable-free run
had <3.1 mm post-STOP drift and PWM returned to zero. Log:
`xy_20260924_173758_901156/`. Visual confirmation of this exact repeat
was subsequently provided by the user: physical motion was normal and
matched the plot.
No speed above 0.35 m/s or distance above 0.40 m was retested after
this upload. Logs: `xy_20260924_173404_965974/`,
`xy_20260924_173419_280296/`, `xy_20260924_173438_180654/`,
`xy_20260924_173501_416255/`, `xy_20260924_173523_336170/`,
`xy_20260924_173536_359308/`.

## Corrected drive-wheel diameter (source only)

The user supplied the actual drive-wheel diameter as 5 in = 127 mm,
rather than the 80 mm diameter implied by the old 40 mm radius. Firmware
source now uses a single shared 63.5 mm drive-wheel radius in both
kinematics implementations. The 29 mm passive odometry-wheel radius,
MAX_RPM=400, 2.0 m/s position-command ceiling, PID gains, and 54 kHz
motor PWM frequency were not changed. Under the *current software
kinematic model*, a pure X/Y 2.0 m/s command requires about 301 RPM per
wheel; diagonal translation or yaw correction requires more. The user's
~500 RPM motor figure is no-load, not verified loaded speed. The
earlier speed commands were calculated with the incorrect 40 mm radius,
so old commanded-speed labels must not be treated as calibrated physical
speed. Build and drive-geometry/position-profile host tests passed;
this source correction is not yet uploaded or physically verified.
Do not apply 0.5–2.0 m/s position presets until loaded speed and braking
are measured safely with the corrected geometry. The requested profile
slots can be recorded, but no per-speed PID is validated yet.

Trial logs: `xy_20260924_133450_673079/`,
`xy_20260924_133502_695132/`, `xy_20260924_133533_999311/`,
`xy_20260924_133550_120674/`, `xy_20260924_133613_053710/`,
`xy_20260924_133629_321251/`, `xy_20260924_133655_825250/`,
`xy_20260924_133735_402789/`.

## 2026-09-24 front-encoder correction and loaded 0.5 m/s X trials

The user uploaded the corrected 5-in drive-wheel geometry. A physical
hand-spin check then established FL encoder A/B=PA2/PA3 and FR=PA0/PA1;
RL=PA7/PA6 and RR=PA4/PA5 remained unchanged. FR uses the PA1 B-rising
interrupt to avoid PA0/PB0 EXTI0 contention with odometry X. The FL
encoder sign was inverted after a bounded forward pulse showed negative
FL ticks. A later supervised airborne FR test confirmed positive ticks
and ~75 RPM at a 75-RPM command after enabling FR closed-loop speed PID.
On the floor, a 75-RPM 0.65-s four-wheel pulse produced closely matched
wheel ticks and <1 degree yaw change; all four wheel channels were
positive. Motor PWM remains 54 kHz.

Supervised X 0.60-m out-and-back trials with linear command cap 0.5 m/s,
I=0, D=0.1, and unchanged yaw gains compared P=3,4,5,6. P=5 was the
fastest *observed candidate*: total leg times 8.21 s and 8.75 s in two
trials, versus P=3 9.97/10.39 s, P=4 11.02 s, P=6 10.85 s. No
in-motion target overshoot was reported, but the second P=5 outbound
leg moved BACK about 2.4 cm after STOP with PWM=0. The user visually
confirmed that the chassis rolled back a little, without anyone
touching it or a cable pulling it. Immediately before STOP all four
motor outputs still carried roughly 40-56 PWM while the wheels were
nearly stationary, so cutting drive torque plausibly allowed rollback.
This is a hypothesis, not a proven mechanical cause. Do not mark P=5
as a validated preset or raise the speed until post-STOP position error
and the holding/braking behaviour are resolved. The trial script now
records signed post-STOP axis shift and final position error to avoid
mistaking in-motion zero overshoot for a stable stopped position.

Relevant logs: `xy_20260924_184124_379651/` (P3),
`xy_20260924_184354_454458/` (P4),
`xy_20260924_184444_792114/` (P3 repeat),
`xy_20260924_184524_292097/` (P5),
`xy_20260924_184555_539092/` (P6),
`xy_20260924_184631_762556/` (P5 repeat with rollback).

## MDD20A driver clarification — stop and PWM limits

The user identified the motor driver as Cytron MDD20A. Its manufacturer
datasheet truth table says PWM LOW (DIR either state) drives both motor
outputs LOW and selects BRAKE. Therefore firmware `stopAll()` setting
PWM=0 should request the driver's electrical brake while the driver is
powered and healthy; the earlier hypothesis that PWM=0 necessarily
coasts was incorrect. The observed 2.4-cm rollback is real according to
the user, but the cause is unproven: brake torque may not hold static
position, input/driver power or protection may be abnormal, or the
mechanics/omni rollers may allow motion. Check motor supply and ERR/OC
indicators during a safe stationary diagnostic before changing STOP.

The same datasheet specifies standard PWM DC–20 kHz and extended 20–40
kHz with reduced continuous-current capability. The firmware remains at
54 kHz at the user's explicit instruction, above both published ranges.
No PWM-frequency change was made; do not claim the MDD20A is operating
within specification or certify loaded high-speed presets under this
condition. Datasheet (authored by Cytron, mirrored by RobotShop):
https://cdn.robotshop.com/media/c/cyt/rb-cyt-287/pdf/cytron-20a-6v-30v-dual-dc-motor-driver-datasheet.pdf

## Moving-trajectory-only 0.5 m/s candidate (not stored in firmware)

At the user's explicit request, later gain selection used the moving
trajectory (settling time, in-motion overshoot, yaw, and lateral error),
not post-STOP rollback. Safety STOPs remained active. In Y 0.60-m
out-and-back trials, repeatedly recapturing the current heading as the
new target allowed heading to drift cumulatively toward 4 degrees.
Re-testing with a fixed 0-rad yaw target reduced Y lateral error from
up to 3-4 cm to about 1 cm. Under fixed yaw, Y P=6/I=0/D=0.1 took
9.39 s total, with zero reported in-motion overshoot and ~1.0 cm
maximum off-axis error; P=5 took 10.79 s and P=7 took 11.87 s.
An X P=5/I=0/D=0.1 trial at the same fixed yaw took 8.21 s total,
with zero reported in-motion overshoot and <1 cm off-axis error.

Candidate 0.5 m/s settings are X=(5,0,0.1), Y=(6,0,0.1),
yaw=(9.5,0.4), angular ceiling=1.5 rad/s. These were sent to the
currently connected board via the existing PID and speed commands, but
are volatile and are not a firmware preset. At the user's request, wait
until the remaining target speeds are measured before adding a profile
table or a new preset command. No gains have been established at
1.0/1.5/2.0 m/s.

Relevant fixed-yaw logs: `xy_20260924_190309_982322/` (Y P5),
`xy_20260924_190347_713448/` (Y P6),
`xy_20260924_190419_753526/` (Y P7),
`xy_20260924_190512_296532/` (X P5).

## Revised physical workspace: 1 x 1 m robot-center travel

The user clarified that the *robot center* may move in a 1 x 1 m square;
the earlier interpretation as a floor opening including the chassis was
wrong. Starting at the square center, the supervised script now limits
axis goals to 0.40 m and trips at 0.45 m displacement in either axis.
It requires an explicit centered-start assertion and rejects commanded
speed above 0.44 m/s for that leg. This software trip does not guarantee
the robot can brake before a physical boundary. No motion was commanded.

With the current firmware braking envelope
`sqrt(2 * 0.25 m/s^2 * (remaining_distance - 0.01 m))`, a centered 0.40 m
axis leg reaches at most about 0.44 m/s *commanded* speed. Even a full
1.0 m side-to-side path, if separately established, has an envelope below
0.71 m/s. Thus 1.0, 1.5 and 2.0 m/s cannot be genuinely tuned in this
workspace with the present controller; no PID preset is claimed for them.

## First trial inside the clarified 1 x 1 m center workspace

After the user confirmed the robot was centered and supervised, a bounded
X 0.30 m out-and-back was run at a 0.35 m/s command with X=(5,0,0.1),
Y=(6,0,0.1), fixed yaw target 0. The outbound leg settled in 5.06 s,
without in-motion target overshoot; peak measured odometry speed was
0.235 m/s and peak yaw error 1.19 degrees. The return did not settle
within 20 s. At about 9.1 s into the return, X odometry jumped from
0.3721 to 0.3309 m (~4.12 cm) in ~0.11 s after a period where all four
drive-wheel tick counters remained unchanged, with RPM near zero. The
subsequent correction took many seconds. This segment is invalid for
gain selection; it does not establish whether the passive wheel moved
while the chassis was stationary, the chassis slid, or an encoder signal
was wrong. The script STOPed; final PWM was zero and position control
inactive. No new PID preset was saved. Report:
`xy_20260924_192019_906128/`. The trial script now faults on >3 cm pose
steps when drive-wheel ticks have been stationary for >0.3 s.

The user confirmed the chassis physically moved at the 4.1-cm event.
Review of the trial script found a separate, concrete dwell-timer bug:
it reset its 1-second in-goal timer whenever a ~20-Hz API poll happened
between ~10-Hz pose samples. The return had already entered the 3-cm
position/1-degree yaw acceptance region several seconds before the physical
movement, but the script failed to STOP. It continued requesting a goal
with about -32 to -41 PWM while drive-wheel ticks stayed fixed. The script
now counts consecutive wall-clock time in tolerance, while separately
requiring fresh pose_sequence updates. This may have prevented the long
hold, but the cause of the physical slide itself is not established.
The bounded retests below were run only after this fix.

## Bounded retests after the dwell-timer fix

With the same fixed yaw target and candidate gains, X 0.20 m at a
0.25 m/s command settled outbound/return in 3.53/5.61 s with no
in-motion overshoot, yaw error under 0.45 degrees, and under 1 mm
post-STOP shift (`xy_20260924_192441_222326/`). X 0.30 m at a
0.35 m/s command settled in 6.45/7.60 s, no in-motion overshoot,
and at most ~2 mm post-STOP shift (`xy_20260924_192507_077766/`).
No repeat of the 4.1-cm event occurred in these two trials.

At 0.35 m distance / 0.40 m/s command, X settled in 4.88/5.63 s
without in-motion overshoot; measured peak odometry speed was about
0.33 m/s and final return error ~2.7 cm
(`xy_20260924_192600_392183/`). Y settled in 7.57/7.47 s without
in-motion overshoot; peak odometry speed ~0.34 m/s and final return
error under 1 cm (`xy_20260924_192624_796180/`). A transient
`T:ERR:COMMAND` occurred in the Y trial's automatic post-test restore,
not during either motion leg. Subsequent separate STOP, X/Y PID, yaw PID,
and speed restore commands succeeded; PWM=0 and position control inactive
were verified. The script now retries each idempotent restore action
independently so one serial error cannot skip later steps. The commanded
0.40 m/s cap was *not reached*, so this is not an empirically validated
0.40 m/s PID profile. No firmware presets were added or uploaded.

## Rough web-tuning starting values (not firmware presets)

The user accepted rough values for later manual refinement. A separate
CSV, `XY_SPEED_PRESET_DRAFT.csv`, carries the measured low-speed X/Y/yaw
candidate forward unchanged as a *starting point* for requested caps
0.5, 1.0, 1.5 and 2.0 m/s. Rows at 1.0/1.5/2.0 are untested, not
independently tuned gains; the 0.5 row was not verified at that actual
speed in the new 1 x 1 m workspace. No draft row was embedded in STM32.
The current braking envelope gives the same commanded speed curve for
all requested caps >=1.0 m/s over a 1 m or shorter leg, so distinguishable
high-speed profiles require a different, validated trajectory envelope.

## Requested-cap 0.5 m/s check after motor power was restored

After the user powered the drive and authorized rough web tuning, X/Y
0.35-m out-and-back trials were run with the draft gains and a requested
0.5-m/s linear cap. The firmware braking envelope on that leg is only
0.412 m/s, and onboard odometry peaks were 0.316 m/s on X and
0.297 m/s on Y (outbound), so the robot did not demonstrate 0.5 m/s.
Both moving traces reported zero target overshoot. X post-STOP shifts
were ~1.0/1.5 cm. Y outbound shifted ~3.0 cm after STOP, just below
the scripted 3-cm trip, and Y return shifted ~1.5 cm. A later read-only
snapshot changed another ~3 cm while PWM remained zero, then held
steady on the next 1-second check; whether the chassis or only passive
odometry wheel moved in this later event was not physically confirmed.
Reports: `xy_20260924_193121_565753/` and
`xy_20260924_193148_596326/`. PWM=0 and position control inactive
were verified. Trials at 1/1.5/2 m/s were not run: at this distance
all those caps produce the same planned speed curve as 0.5, while the
post-STOP displacement makes repetition without new evidence unhelpful.
The CSV draft keeps untested rows explicitly marked as starting values,
not validated velocity-specific PID gains. No firmware preset was added.

## Detailed low-speed tuning readiness check

The supervised XY trial now observes five seconds after every STOP and
records drive-wheel RPM, PWM, and ticks alongside X/Y/yaw in that interval;
it faults above 2 cm reported post-STOP displacement. X 0.20 m at a
0.25 m/s requested cap (`xy_20260924_193600_349905/`) and Y 0.35 m
at 0.40 m/s (`xy_20260924_193633_537641/`) both completed with zero
in-motion target overshoot and under 1 mm shift during each 5-second
post-STOP watch. Y 0.35 m with a *requested* 0.50 m/s cap
(`xy_20260924_193701_053941/`) also had under 1 mm shift after STOP,
but actual odometry peaks were only 0.29-0.31 m/s. A separate 10-second
read-only stationary check found unchanged X/Y/yaw with PWM=0.

The dashboard's WheelTuner page now includes browser-only XY draft
profiles for requested 0.5/1/1.5/2 m/s, with Load, Save, Download JSON,
and Send XY gains + speed (no motion) controls. Sending gains requires
reported PWM=0, mask=0, and inactive position control. This is ready
for human-supervised, bounded *low-speed* fine tuning; it does not make
1-2 m/s physically attainable in the present 1 x 1 m travel area. No
firmware PID presets were added, and the 54-kHz PWM setting was untouched.

## Requested 1/1.5/2 m/s cap sweep, stopped on measured fault

At the user's explicit request, the remaining speed *commands* were
tested at a bounded negative 0.25-m axis leg with the same draft gains,
while logging actual odometry speed and not representing the cap as
attained. A 1.0-m/s requested cap completed X/Y out-and-back with no
in-motion target overshoot; observed peak speeds were ~0.206/0.202 m/s
outbound, and the firmware envelope limited the command to at most
0.346 m/s on this leg. Reports: `xy_20260924_194531_278184/` and
`xy_20260924_194557_520489/`.

The 1.5-m/s requested-cap X outbound leg reached its target, but its
in-motion peak derived from the pose samples was only ~0.194 m/s. Its
post-STOP Y pose rose from 0.0922 to 0.1198 m (~2.76 cm) over two
50-ms samples about 3.2 seconds after STOP. All four drive-wheel tick
counters were unchanged throughout, and PWM/RPM were zero. The trial
tripped its 2-cm post-STOP limit, sent STOP, and did not command the
return leg. Report: `xy_20260924_194626_603674/`. A read-only state
confirmed PWM=0, mask=0, inactive position control. The user was asked
whether the chassis physically slid or only the Y graph changed.
No 1.5-m/s Y or 2.0-m/s motion was commanded after this fault. The
observations do not support distinct speed-specific PID values;
remaining CSV rows remain explicitly unvalidated.

## Interrupted 2.0-m/s cap request after clarification

The assistant interpreted "here" as the offered 0.30-m in-bounds option
and started an X 0.30-m out-and-back at a requested cap of 2.0 m/s.
The user immediately clarified that they meant a full 1.0-m leg.
The assistant issued STOP and SIGINT to the running bounded trial.
The 0.30-m outbound leg had already finished (peak measured odometry
speed ~0.239 m/s, no in-motion overshoot), and the return had begun
before interruption; no completed return result is claimed. The script
finally block sent STOP and restored the default live gains/speed.
Read-only state after interruption showed mask=0, all PWM=0 and position
control inactive. Report: `xy_20260924_195623_391087/`. A full 1-m
straight leg was not commanded. The current pose and the 1 x 1 m
center-travel bound do not provide a safe 1-m straight goal from the
robot's present location.

The live WheelTuner build also checks that a manual XY goal is within
±0.40 m of the reset origin and that the reported pose starts within
±0.45 m. While its position-goal heartbeat is active, it sends STOP if
reported X or Y exceeds ±0.45 m. This is a software last-resort trip,
not a guarantee against collision: pose can be wrong or stopping distance
can exceed the 5-cm margin. The robot must physically start at the
center of the known 1 x 1 m *center-travel* square.
