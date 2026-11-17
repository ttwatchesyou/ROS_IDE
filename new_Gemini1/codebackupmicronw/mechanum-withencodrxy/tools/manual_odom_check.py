#!/usr/bin/env python3
"""Read-only XY/yaw trace while a person moves the robot by hand.

Motor-driver power must be off while STM32/USB telemetry remains powered.
This tool sends no serial commands and changes no firmware or PID settings.
"""

import argparse
import json
import math
from pathlib import Path
import time
from urllib.request import urlopen


BASE = "http://127.0.0.1:8001"


def state(cursor):
    with urlopen(f"{BASE}/api/tuner/state?pose_after={cursor}", timeout=2) as response:
        result = json.load(response)
    if not result.get("connected") or not (result.get("pose") or {}).get("imu_ok"):
        raise RuntimeError("STM32/IMU unavailable")
    telemetry = result.get("telemetry") or {}
    if telemetry.get("ms") is None:
        raise RuntimeError("STM32 telemetry missing")
    if any(abs(value) > 0.1 for value in telemetry.get("pwm", [])):
        raise RuntimeError("Nonzero PWM: abort manual observation")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=float, default=30)
    args = parser.parse_args()
    if not 5 <= args.seconds <= 60:
        parser.error("observation length must be 5–60 s")

    baseline = state(999999999)
    cursor = baseline.get("pose_sequence", 0)
    rows = []
    fault = None
    last_ms = baseline["telemetry"]["ms"]
    last_update = time.monotonic()
    began = time.monotonic()
    try:
        while time.monotonic() - began < args.seconds:
            current = state(cursor)
            now = time.monotonic()
            board_ms = current["telemetry"]["ms"]
            if board_ms < last_ms:
                raise RuntimeError("STM32 restarted during observation")
            if board_ms != last_ms:
                last_ms, last_update = board_ms, now
            if now - last_update > 0.5:
                raise RuntimeError("STM32 telemetry stale")
            for pose in current.get("pose_samples", []):
                if not all(math.isfinite(pose.get(key, float("nan")))
                           for key in ("x", "y", "yaw")):
                    raise RuntimeError("Invalid pose sample")
                rows.append({"seq": pose["seq"], "t": pose["t"],
                             "x": pose["x"], "y": pose["y"],
                             "yaw": pose["yaw"]})
            if current.get("pose_samples"):
                cursor = max(row["seq"] for row in current["pose_samples"])
            time.sleep(0.08)
    except (Exception, KeyboardInterrupt) as error:
        fault = str(error) or "interrupted"

    steps = [{"t": b["t"], "dx": b["x"] - a["x"],
              "dy": b["y"] - a["y"], "dt": b["t"] - a["t"]}
             for a, b in zip(rows, rows[1:]) if b["t"] > a["t"]]
    largest = sorted(steps, key=lambda row: math.hypot(row["dx"], row["dy"]),
                     reverse=True)[:10]
    report = {"fault": fault, "baseline_pose": baseline["pose"],
              "seconds_requested": args.seconds, "samples": rows,
              "largest_steps": largest}
    output = Path(__file__).resolve().parents[1] / "tuning_reports" / (
        "manual_odom_" + time.strftime("%Y%m%d_%H%M%S") + ".json")
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(output), "fault": fault,
                      "samples": len(rows), "baseline_pose": baseline["pose"],
                      "final_pose": rows[-1] if rows else None,
                      "largest_steps": largest[:5]}, indent=2))
    return bool(fault)


if __name__ == "__main__":
    raise SystemExit(main())
