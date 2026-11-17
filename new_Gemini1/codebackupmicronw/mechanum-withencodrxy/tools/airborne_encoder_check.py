#!/usr/bin/env python3
"""Brief airborne wheel test: drive one wheel, watch stationary XY odometry.

Use only with *all* drive and dead-wheel odometers clear of the floor/stand.
The robot must be secured and an emergency stop within reach. --run required.
"""
import argparse
import json
import math
from pathlib import Path
import time
from urllib.request import Request, urlopen


BASE = "http://127.0.0.1:8001"
WHEELS = (("FL", 1, 0), ("FR", 2, 1), ("RL", 4, 2), ("RR", 8, 3))


def api(path, body=None):
    payload = None if body is None else json.dumps(body).encode()
    request = Request(BASE + path, data=payload,
                      headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=3) as response:
        result = json.load(response)
    if result.get("status") == "error":
        raise RuntimeError(result)
    return result


def command(action, **kwargs):
    return api("/api/tuner/command", {"action": action, **kwargs})


def state():
    result = api("/api/tuner/state")
    if not result.get("connected") or not result.get("pose", {}).get("imu_ok"):
        raise RuntimeError("serial or IMU unavailable")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--rpm", type=float, default=50.0)
    parser.add_argument("--seconds", type=float, default=1.5)
    parser.add_argument("--wheel", choices=("all", "FL", "FR", "RL", "RR"),
                        default="all", help="test only this wheel, or all sequentially")
    args = parser.parse_args()
    if not args.run:
        parser.error("--run required for motor motion")
    if not (0 < args.rpm <= 100 and .5 <= args.seconds <= 2):
        parser.error("airborne check limited to <=100 RPM and <=2 s per wheel")

    report = {"rpm_command": args.rpm, "seconds": args.seconds,
              "wheels": [], "fault": None}
    try:
        command("stop")
        initial = state()
        if any(abs(v) > .1 for v in initial["telemetry"].get("pwm", [])):
            raise RuntimeError("motor PWM not zero before check")
        for name, mask, index in WHEELS:
            if args.wheel != "all" and name != args.wheel:
                continue
            command("stop")
            time.sleep(.3)
            baseline = state()["pose"]
            start_x, start_y = baseline["x"], baseline["y"]
            start_yaw = baseline["yaw"]
            start_ticks = state()["telemetry"]["ticks"][index]
            samples = []
            command("select", mask=mask)
            command("rpm", rpm=args.rpm)
            command("start")
            started = time.monotonic()
            last_heartbeat = started
            try:
                while time.monotonic() - started < args.seconds:
                    now = time.monotonic()
                    if now - last_heartbeat >= .2:
                        # START refreshes the STM32 command watchdog without
                        # resetting the wheel PID integrator as RPM does.
                        command("start")
                        last_heartbeat = now
                    current = state()
                    pose, tel = current["pose"], current["telemetry"]
                    delta_x = pose["x"] - start_x
                    delta_y = pose["y"] - start_y
                    samples.append({"t": now-started, "dx": delta_x,
                                    "dy": delta_y, "rpm": tel["rpm"][index],
                                    "raw_rpm": tel["raw_rpm"][index],
                                    "pwm": tel["pwm"][index],
                                    "ticks": tel["ticks"][index],
                                    "mask": tel["mask"],
                                    "target_rpm": tel["target_rpm"],
                                    "board_ms": tel["ms"]})
                    if now-started > .5 and not any(abs(s["pwm"]) > 5 for s in samples):
                        raise RuntimeError(f"{name}: drive PWM never enabled; test invalid")
                    if math.hypot(delta_x, delta_y) > .03:
                        raise RuntimeError(
                            f"{name}: odometry moved >3 cm with dead wheels airborne: "
                            f"X={delta_x:.3f} Y={delta_y:.3f}")
                    yaw_delta = math.atan2(math.sin(pose["yaw"] - start_yaw),
                                           math.cos(pose["yaw"] - start_yaw))
                    if abs(yaw_delta) > math.radians(5):
                        raise RuntimeError(f"{name}: chassis yaw changed >5 degrees")
                    time.sleep(.05)
            finally:
                command("stop")
            time.sleep(.4)
            final = state()
            end_pose = final["pose"]
            report["wheels"].append({"wheel": name, "samples": samples,
                "ticks_delta": final["telemetry"]["ticks"][index]-start_ticks,
                "final_dx": end_pose["x"]-start_x,
                "final_dy": end_pose["y"]-start_y,
                "max_pwm": max(abs(s["pwm"]) for s in samples),
                "max_rpm": max(abs(s["rpm"]) for s in samples)})
            if math.hypot(end_pose["x"]-start_x, end_pose["y"]-start_y) > .03:
                raise RuntimeError(f"{name}: odometry drifted >3 cm after STOP")
    except (Exception, KeyboardInterrupt) as error:
        report["fault"] = str(error) or "interrupted"
    finally:
        try:
            command("stop")
        except Exception as error:
            report["stop_error"] = str(error)
    output = Path(__file__).resolve().parents[1] / "tuning_reports" / (
        "airborne_" + time.strftime("%Y%m%d_%H%M%S") + ".json")
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(output), "fault": report["fault"],
        "wheels": [{k: v for k, v in row.items() if k != "samples"}
                   for row in report["wheels"]]}, indent=2))
    return bool(report["fault"] or report.get("stop_error"))


if __name__ == "__main__":
    raise SystemExit(main())
