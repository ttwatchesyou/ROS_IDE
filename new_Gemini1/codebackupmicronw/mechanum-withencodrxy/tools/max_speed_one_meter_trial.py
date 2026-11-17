#!/usr/bin/env python3
"""One supervised straight-line velocity trial; sends STOP at 1 m odometry.

This is not position control: inertia may carry the chassis past 1 m after
STOP. Run only in a verified clear corridor with a physical emergency stop.
"""
import argparse
import json
import math
from pathlib import Path
import time
from urllib.request import Request, urlopen


def api(base, path, data=None):
    body = None if data is None else json.dumps(data).encode()
    request = Request(base + path, data=body,
                      headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=1.5) as response:
        return json.load(response)


def command(base, action, **kwargs):
    result = api(base, "/api/tuner/command", {"action": action, **kwargs})
    if result.get("status") != "ok":
        raise RuntimeError(f"{action} rejected: {result}")


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--clear-corridor-confirmed", action="store_true")
    parser.add_argument("--base", default="http://127.0.0.1:8001")
    args = parser.parse_args()
    if not args.run or not args.clear_corridor_confirmed:
        parser.error("--run and --clear-corridor-confirmed required")

    # Five-inch wheel: 500 rev/min * circumference / 60 s/min.
    forward_mps = 500.0 * math.pi * 0.127 / 60.0
    report_dir = (Path(__file__).resolve().parents[1] / "tuning_reports" /
                  (time.strftime("max_speed_%Y%m%d_%H%M%S") +
                   f"_{time.time_ns() % 1000000:06d}"))
    report_dir.mkdir(parents=True)
    report = {"requested_wheel_rpm": 500, "requested_twist_mps": forward_mps,
              "stop_threshold_m": 1.0, "samples": []}
    origin = None
    moving = False
    started = None
    last_board_ms = None
    last_board_update = time.monotonic()
    last_board_wall = None
    previous_x = None
    previous_t = None
    last_progress = time.monotonic()
    peak_x = 0.0
    peak_abs_rpm = 0.0
    peak_abs_pwm = 0.0
    stop_x = None
    try:
        command(args.base, "stop")
        initial = api(args.base, "/api/tuner/state")
        pose = initial.get("pose") or {}
        tel = initial.get("telemetry") or {}
        if not initial.get("connected") or not pose.get("imu_ok"):
            raise RuntimeError("USB or IMU unavailable")
        if not all(math.isfinite(pose.get(key, float("nan"))) for key in ("x", "y", "yaw")):
            raise RuntimeError("Pose unavailable")
        if max(abs(float(pwm)) for pwm in tel.get("pwm", [float("inf")])) > 0.1:
            raise RuntimeError("Motors not stopped at start")
        if max(abs(pose["x"]), abs(pose["y"])) > 0.05:
            raise RuntimeError("Reset pose near the physical corridor start first")
        origin = {key: pose[key] for key in ("x", "y", "yaw")}
        last_board_ms = tel.get("ms")
        if last_board_ms is None:
            raise RuntimeError("No board telemetry")
        # The API can drain an old serial backlog much faster than real time.
        # In that condition the apparent pose is historical and must never be
        # used to decide when to stop a high-speed run.
        fresh_start = time.monotonic()
        time.sleep(0.5)
        fresh_state = api(args.base, "/api/tuner/state")
        fresh_wall = time.monotonic() - fresh_start
        fresh_ms = (fresh_state.get("telemetry") or {}).get("ms")
        if fresh_ms is None or not 0.75*fresh_wall <= (fresh_ms-last_board_ms)/1000.0 <= 1.30*fresh_wall:
            raise RuntimeError("Telemetry backlog or board clock mismatch; motion inhibited")
        last_board_ms = fresh_ms
        last_board_wall = time.monotonic()
        command(args.base, "yaw_hold", enabled=True)
        # TWIST starts motion immediately and latches the current heading.
        command(args.base, "twist", vx=forward_mps, vy=0, wz=0)
        moving = True
        started = time.monotonic()
        last_heartbeat = started
        last_progress = started
        while True:
            now = time.monotonic()
            if now - started > 4.0:
                raise RuntimeError("4-second motion timeout")
            state = api(args.base, "/api/tuner/state")
            pose = state.get("pose") or {}
            tel = state.get("telemetry") or {}
            if not state.get("connected") or not pose.get("imu_ok"):
                raise RuntimeError("USB or IMU lost")
            x = pose["x"] - origin["x"]
            y = pose["y"] - origin["y"]
            yaw = math.atan2(math.sin(pose["yaw"]-origin["yaw"]),
                             math.cos(pose["yaw"]-origin["yaw"]))
            board_ms = tel.get("ms")
            if board_ms is None or board_ms < last_board_ms:
                raise RuntimeError("Board telemetry missing or reset")
            board_elapsed = (board_ms-last_board_ms)/1000.0
            wall_elapsed = now-last_board_wall
            if board_elapsed > 1.30*wall_elapsed + 0.08:
                raise RuntimeError("Telemetry replay detected during motion")
            if board_ms != last_board_ms:
                last_board_ms, last_board_update, last_board_wall = board_ms, now, now
            if now - last_board_update > 0.25:
                raise RuntimeError("Board telemetry stale")
            rpm = tel.get("rpm") or []
            pwm = tel.get("pwm") or []
            if len(rpm) != 4 or len(pwm) != 4:
                raise RuntimeError("Wheel telemetry missing")
            peak_x = max(peak_x, x)
            peak_abs_rpm = max(peak_abs_rpm, *(abs(value) for value in rpm))
            peak_abs_pwm = max(peak_abs_pwm, *(abs(value) for value in pwm))
            report["samples"].append({"t": now-started, "x": x, "y": y,
                                      "yaw": yaw, "rpm": rpm, "pwm": pwm,
                                      "ticks": tel.get("ticks"), "board_ms": board_ms})
            if x >= 1.0:
                command(args.base, "stop")
                moving = False
                stop_x = x
                break
            if x < -0.05 or x > 1.5 or abs(y) > 0.2 or abs(yaw) > math.radians(10):
                raise RuntimeError(f"Path trip: x={x:.3f} y={y:.3f} yaw={math.degrees(yaw):.1f}")
            if previous_x is not None and previous_t is not None:
                dt = now - previous_t
                if x - previous_x > max(0.12, 5.0*dt):
                    raise RuntimeError("Odometry jumped during run")
            if previous_x is None or x > previous_x + 0.002:
                last_progress = now
            if now - last_progress > 0.8:
                raise RuntimeError("No forward progress")
            previous_x, previous_t = x, now
            # START refreshes the one-second board watchdog without
            # resetting the yaw-hold target, unlike resending TWIST.
            if now - last_heartbeat > 0.20:
                command(args.base, "start")
                last_heartbeat = now
            time.sleep(0.025)

        # Measure the actual coast after STOP, without issuing a return leg.
        until = time.monotonic() + 5.0
        while time.monotonic() < until:
            state = api(args.base, "/api/tuner/state")
            pose = state.get("pose") or {}
            tel = state.get("telemetry") or {}
            report["samples"].append({"t": time.monotonic()-started,
                                      "x": pose.get("x", float("nan"))-origin["x"],
                                      "y": pose.get("y", float("nan"))-origin["y"],
                                      "yaw": pose.get("yaw"), "rpm": tel.get("rpm"),
                                      "pwm": tel.get("pwm"), "board_ms": tel.get("ms"),
                                      "after_stop": True})
            time.sleep(0.1)
        report["stop_command_x_m"] = stop_x
        report["final_x_m"] = report["samples"][-1]["x"]
        report["peak_abs_wheel_rpm"] = peak_abs_rpm
        report["peak_abs_pwm"] = peak_abs_pwm
    except (Exception, KeyboardInterrupt) as exc:
        report["fault"] = str(exc) or "interrupted"
    finally:
        # STOP even if the HTTP link, IMU, or local monitor fails. The STM32
        # one-second watchdog is the independent backstop if this fails too.
        try:
            command(args.base, "stop")
            moving = False
        except Exception as exc:
            report["stop_error"] = str(exc)
        report["origin"] = origin
        report["moving_at_exit"] = moving
        (report_dir / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"report": str(report_dir), **{key: value for key, value in report.items()
                                                    if key != "samples"}}, indent=2))
    return 1 if report.get("fault") or report.get("stop_error") else 0


if __name__ == "__main__":
    raise SystemExit(main())
