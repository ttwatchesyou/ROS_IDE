#!/usr/bin/env python3
"""Run a supervised yaw step through the dashboard API."""
import argparse
import json
import math
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def wrap(value):
    return math.atan2(math.sin(value), math.cos(value))


def api(base, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = Request(base + path, data=data,
                      headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=2) as response:
            return json.load(response)
    except HTTPError as error:
        detail = json.loads(error.read().decode()).get("detail", str(error))
        raise RuntimeError(detail) from error


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8001")
    parser.add_argument("--kp", type=float, required=True)
    parser.add_argument("--kd", type=float, required=True)
    parser.add_argument("--max-wz", type=float, required=True)
    parser.add_argument("--angle-deg", type=float, default=90)
    parser.add_argument("--return-to-zero", action="store_true",
                        help="after the outbound step, command the starting yaw")
    parser.add_argument("--absolute-cycle", action="store_true",
                        help="first home to absolute yaw 0, then run 0 -> angle -> 0")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()
    if not args.run:
        parser.error("--run is required for physical motion")
    if not (0 < args.angle_deg <= 90 and 0 <= args.kp <= 10 and
            0 <= args.kd <= 3 and 0 < args.max_wz <= 3.0 and 1 <= args.timeout <= 30):
        parser.error("trial is outside supervised bounds")

    report_dir = (Path(__file__).resolve().parents[1] / "tuning_reports" /
                  time.strftime("yaw_web_%Y%m%d_%H%M%S"))
    report_dir.mkdir(parents=True)
    samples = []
    pose_history = []
    fault = None
    last_ms = None
    last_fresh = time.monotonic()

    def state():
        nonlocal last_ms, last_fresh
        current = api(args.base, "/api/tuner/state?pose_after=0")
        if not current.get("connected") or not current.get("pose", {}).get("imu_ok"):
            raise RuntimeError("USB/IMU telemetry unavailable")
        ms = (current.get("telemetry") or {}).get("ms")
        if ms is None or (last_ms is not None and ms < last_ms):
            raise RuntimeError("Missing telemetry or STM32 restarted")
        if ms != last_ms:
            last_ms, last_fresh = ms, time.monotonic()
        if time.monotonic() - last_fresh > .3:
            raise RuntimeError("Telemetry stopped updating")
        if not all(math.isfinite(current['pose'][k]) for k in ('x', 'y', 'yaw')):
            raise RuntimeError("Invalid pose")
        return current

    def command(action, **values):
        return api(args.base, "/api/tuner/command", {"action": action, **values})

    def run_leg(label, start_yaw, target_yaw, hold_x, hold_y):
        began = time.monotonic()
        last_heartbeat = 0.0
        stable_since = None
        peak_progress = -1e9
        direction = 1 if wrap(target_yaw - start_yaw) >= 0 else -1
        expected_angle_deg = abs(math.degrees(wrap(target_yaw - start_yaw)))
        initial = state()
        cursor = initial.get('pose_sequence', 0)
        prev_pose = None
        rate = 0.0
        peak_rate = 0.0
        while time.monotonic() - began < args.timeout:
            now = time.monotonic()
            current = state()
            fresh_pose = False
            for s in current.get('pose_samples', []):
                if s['seq'] <= cursor: continue
                cursor = s['seq']
                fresh_pose = True
                pose_history.append({'leg': label, **s})
                degrees = math.degrees(s['yaw'])
                if args.absolute_cycle and not -1 <= degrees <= 91:
                    raise RuntimeError(f"Outside 0..90 test envelope: {degrees:.2f} deg")
                peak_progress = max(peak_progress, math.degrees(wrap(s['yaw']-start_yaw))*direction)
                if prev_pose and s['t'] > prev_pose['t']:
                    rate = wrap(s['yaw']-prev_pose['yaw'])/(s['t']-prev_pose['t'])
                    peak_rate = max(peak_rate, abs(rate))
                    if abs(rate) > args.max_wz*1.5+.2:
                        raise RuntimeError(f"Excessive measured yaw rate: {rate:.2f} rad/s")
                prev_pose = s
            if now - last_heartbeat >= .25:
                command("goal", x=hold_x, y=hold_y, yaw=target_yaw)
                last_heartbeat = now
            pose = current["pose"]
            telemetry = current.get("telemetry") or {}
            error = wrap(target_yaw - pose["yaw"])
            progress = math.degrees(wrap(pose["yaw"] - start_yaw)) * direction
            peak_progress = max(peak_progress, progress)
            row = {"leg": label, "elapsed": now - began, "yaw": pose["yaw"],
                   "target": target_yaw, "error": error, "x": pose["x"],
                   "y": pose["y"], "rpm": telemetry.get("rpm"),
                   "pwm": telemetry.get("pwm"), "board_ms": telemetry['ms'],
                   "yaw_rate_radps": rate}
            samples.append(row)
            if math.hypot(pose["x"] - hold_x, pose["y"] - hold_y) > .12:
                raise RuntimeError(f"{label}: XY drift exceeded 12 cm")
            if progress < -1 or progress > expected_angle_deg + 1:
                raise RuntimeError(f"{label}: unexpected yaw excursion {progress:.1f} deg")
            if fresh_pose and abs(math.degrees(error)) <= .85 and abs(rate) <= .05:
                stable_since = stable_since or now
                if now - stable_since >= 1.0:
                    command("stop")
                    return {"time_s": now - began,
                            "peak_yaw_rate_radps": peak_rate,
                            "overshoot_deg": max(0.0, peak_progress - expected_angle_deg),
                            "final_error_deg": math.degrees(error)}
            else:
                stable_since = None
            time.sleep(.05)
        raise RuntimeError(f"{label}: did not settle within {args.timeout} s")

    result = {"parameters": vars(args)}
    try:
        command("stop")
        current = state()
        pose = current["pose"]
        telemetry = current.get("telemetry") or {}
        if any(abs(value) > .1 for value in telemetry.get("pwm", [])):
            raise RuntimeError("motor PWM is not zero before trial")
        initial_yaw, hold_x, hold_y = pose["yaw"], pose["x"], pose["y"]
        if args.absolute_cycle and not -1 <= math.degrees(initial_yaw) <= 91:
            raise RuntimeError("Initial yaw outside 0..90 range; refusing a long prehome")
        # Isolate the yaw loop. Dead-wheel drift must not inject vx/vy while
        # measuring yaw gains; firmware defaults are restored in finally.
        command("pos_pid_x", kp=0, ki=0, kd=0)
        command("pos_pid_y", kp=0, ki=0, kd=0)
        command("yaw_pid", kp=args.kp, kd=args.kd, maximum=args.max_wz)
        command("pos_speed", linear=.05, angular=args.max_wz)
        if args.absolute_cycle:
            result["prehome"] = run_leg("prehome_to_0", initial_yaw, 0.0,
                                        hold_x, hold_y)
            time.sleep(.7)
            initial_yaw = 0.0
            target_yaw = math.radians(args.angle_deg)
        else:
            target_yaw = wrap(initial_yaw + math.radians(args.angle_deg))
        result["outbound"] = run_leg("0_to_90", initial_yaw, target_yaw,
                                     hold_x, hold_y)
        if args.return_to_zero or args.absolute_cycle:
            time.sleep(.7)
            result["return"] = run_leg("90_to_0", target_yaw, initial_yaw,
                                       hold_x, hold_y)
    except (Exception, KeyboardInterrupt) as error:
        fault = str(error) or "interrupted"
    finally:
        try:
            command("stop")
            command("pos_pid_x", kp=1.0, ki=0.0, kd=0.1)
            command("pos_pid_y", kp=1.0, ki=0.0, kd=0.1)
        except Exception as stop_error:
            fault = fault or f"STOP failed: {stop_error}"
    result["fault"] = fault
    result["samples"] = len(samples)
    (report_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    (report_dir / "samples.json").write_text(json.dumps(samples) + "\n")
    (report_dir / "pose_samples.json").write_text(json.dumps(pose_history) + "\n")
    print(json.dumps({"report": str(report_dir), **result}, indent=2))
    return 1 if fault else 0


if __name__ == "__main__":
    raise SystemExit(main())
