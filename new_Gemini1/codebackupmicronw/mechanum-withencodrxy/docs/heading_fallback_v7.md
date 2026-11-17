# v7: GOAL without a required IMU

`T:ERR:IMU_REQUIRED` and the IMU-only stop are removed. GOAL continues using
four drive encoders to estimate yaw when IMU data is absent/stale (250 ms).
World XY and yaw control use that estimated heading. Returning IMU measurements
correct the estimate at up to 2 rad/s to avoid instantaneous pose jumps.

Encoder-only yaw drifts with wheel slip and depends on the configured wheel
geometry; it cannot guarantee the same absolute heading accuracy as IMU.
At boot without IMU, initial heading is defined as zero. STOP, command timeout,
odometry outlier checks and loss of BOTH heading sources remain effective.

The dashboard no longer requires imu_ok to send GOAL and labels encoder
fallback. Flash v7 before using fallback; an older board may still reject GOAL.
No physical motion test or firmware upload was performed during this change.
The v6 note about stopping solely on stale IMU is superseded by this document.
