#!/usr/bin/env python3
"""One short, supervised four-wheel ground pulse; never a position goal.

Run only with the robot centered in a clear area and a person at the physical
emergency stop. The STM32 watchdog is 1 s, and this tool always sends STOP.
It is a diagnostic, not an unattended PID autotuner.
"""

import argparse
import json
import math
from pathlib import Path
import time
from urllib.request import Request, urlopen


BASE = "http://127.0.0.1:8001"


def api(path, body=None):
    payload = None if body is None else json.dumps(body).encode()
    request = Request(BASE + path, data=payload,
                      headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=2) as response:
        return json.load(response)


def command(action, **values):
    result = api("/api/tuner/command", {"action": action, **values})
    if result.get("status") != "ok":
        raise RuntimeError(f"{action} rejected: {result}")
    return result


def state():
    result = api("/api/tuner/state?pose_after=999999999")
    pose = result.get("pose") or {}
    telemetry = result.get("telemetry") or {}
    if not result.get("connected") or not pose.get("imu_ok"):
        raise RuntimeError("USB/IMU unavailable")
    if not all(math.isfinite(pose.get(k, float("nan"))) for k in ("x", "y", "yaw")):
        raise RuntimeError("Invalid pose telemetry")
    if telemetry.get("ms") is None or len(telemetry.get("pwm", [])) != 4:
        raise RuntimeError("Motor telemetry unavailable")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpm", type=float, default=75)
    parser.add_argument("--seconds", type=float, default=0.55)
    parser.add_argument("--watch-after", type=float, default=12,
                        help="read-only seconds to observe after STOP")
    parser.add_argument("--run", action="store_true", help="required for physical motion")
    args = parser.parse_args()
    if not args.run:
        parser.error("--run is required for physical motion")
    if not (0 < args.rpm <= 100 and 0.2 <= args.seconds <= 0.75):
        parser.error("ground pulse is capped at 100 RPM and 0.75 s")
    if not 0 <= args.watch_after <= 15:
        parser.error("post-STOP watch is capped at 15 s")

    samples = []
    post_samples = []
    initial = None
    final = None
    fault = None
    try:
        first_check = state()
        time.sleep(0.16)
        second_check = state()
        if second_check["telemetry"]["ms"] <= first_check["telemetry"]["ms"]:
            raise RuntimeError("STM32 telemetry is cached/stale; board may be unpowered")
        command("stop")
        initial = state()
        if any(abs(v) > 0.1 for v in initial["telemetry"]["pwm"]):
            raise RuntimeError("PWM not zero before pulse")
        origin = initial["pose"]
        previous = None
        command("select", mask=15)
        command("rpm", rpm=args.rpm)
        command("start")
        start_time = time.monotonic()
        last_board_ms = initial["telemetry"]["ms"]
        last_board_update = start_time
        while time.monotonic() - start_time < args.seconds:
            current = state()
            now = time.monotonic()
            pose, telemetry = current["pose"], current["telemetry"]
            board_ms = telemetry["ms"]
            if board_ms < last_board_ms:
                raise RuntimeError("STM32 restarted during pulse")
            if board_ms != last_board_ms:
                last_board_ms, last_board_update = board_ms, now
            if now - last_board_update > 0.25:
                raise RuntimeError("STM32 telemetry stale")
            row = {
                "t": now - start_time, "board_ms": board_ms,
                "x": pose["x"], "y": pose["y"], "yaw": pose["yaw"],
                "rpm": telemetry["rpm"], "pwm": telemetry["pwm"],
                "ticks": telemetry["ticks"],
            }
            samples.append(row)
            if abs(row["y"] - origin["y"]) > 0.06:
                raise RuntimeError("reported lateral deviation exceeded 6 cm")
            if abs(row["x"] - origin["x"]) > 0.20:
                raise RuntimeError("reported forward displacement exceeded 20 cm")
            yaw_delta = math.atan2(math.sin(row["yaw"] - origin["yaw"]),
                                   math.cos(row["yaw"] - origin["yaw"]))
            if abs(yaw_delta) > math.radians(5):
                raise RuntimeError("IMU yaw deviation exceeded 5 degrees")
            if previous and math.hypot(row["x"] - previous["x"],
                                       row["y"] - previous["y"]) > 0.04:
                raise RuntimeError("odometry step exceeded 4 cm")
            previous = row
            time.sleep(0.04)
    except (Exception, KeyboardInterrupt) as error:
        fault = str(error) or "interrupted"
    finally:
        try:
            command("stop")
        except Exception as error:
            fault = (fault or "") + f"; STOP failed: {error}"
        try:
            final = state()
        except Exception as error:
            fault = (fault or "") + f"; post-state failed: {error}"

    if final is not None:
        stopped_at = time.monotonic()
        stop_pose = final["pose"]
        while time.monotonic() - stopped_at < args.watch_after:
            try:
                current = state()
                pose, telemetry = current["pose"], current["telemetry"]
                row = {"t_after_stop": time.monotonic() - stopped_at,
                       "board_ms": telemetry["ms"], "x": pose["x"],
                       "y": pose["y"], "yaw": pose["yaw"],
                       "pwm": telemetry["pwm"], "ticks": telemetry["ticks"]}
                post_samples.append(row)
                if any(abs(value) > 0.1 for value in row["pwm"]):
                    command("stop")
                    fault = (fault or "") + "; PWM nonzero after STOP"
                    break
                if (row["t_after_stop"] > 1.0 and
                        math.hypot(row["x"] - stop_pose["x"],
                                   row["y"] - stop_pose["y"]) > 0.10):
                    fault = (fault or "") + "; pose shifted >10 cm after STOP"
                    break
                time.sleep(0.08)
            except Exception as error:
                fault = (fault or "") + f"; post-STOP observation failed: {error}"
                break

    report = {
        "rpm_command": args.rpm, "duration_command_s": args.seconds,
        "fault": fault, "initial_pose": (initial or {}).get("pose"),
        "final_pose": (final or {}).get("pose"),
        "final_pwm": ((final or {}).get("telemetry") or {}).get("pwm"),
        "samples": samples, "post_stop_samples": post_samples,
    }
    output = Path(__file__).resolve().parents[1] / "tuning_reports" / (
        "ground_speed_" + time.strftime("%Y%m%d_%H%M%S") + ".json")
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(output), **{k: v for k, v in report.items()
                                             if k not in ("samples", "post_stop_samples")},
                      "sample_count": len(samples),
                      "post_stop_count": len(post_samples),
                      "post_stop_final": post_samples[-1] if post_samples else None}, indent=2))
    return bool(fault)


if __name__ == "__main__":
    raise SystemExit(main())
