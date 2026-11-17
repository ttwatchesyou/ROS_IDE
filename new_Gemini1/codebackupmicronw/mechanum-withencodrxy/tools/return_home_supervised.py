#!/usr/bin/env python3
"""Supervised low-speed return to the existing odometry origin (0, 0, 0)."""
import json
import math
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


BASE = "http://127.0.0.1:8001"
TARGET = {"x": 0.0, "y": 0.0, "yaw": 0.0}


def api(path, body=None):
    payload = None if body is None else json.dumps(body).encode()
    request = Request(BASE + path, data=payload,
                      headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=2) as response:
            return json.load(response)
    except HTTPError as exc:
        raise RuntimeError(exc.read().decode(errors="replace")) from exc


def command(action, **kwargs):
    response = api("/api/tuner/command", {"action": action, **kwargs})
    if response.get("status") != "ok":
        raise RuntimeError(f"{action} rejected: {response}")


def state():
    data = api("/api/tuner/state?pose_after=999999999")
    pose = data.get("pose") or {}
    telemetry = data.get("telemetry") or {}
    if not data.get("connected") or not pose.get("imu_ok"):
        raise RuntimeError("USB/IMU unavailable")
    if not all(math.isfinite(pose.get(key, float("nan"))) for key in ("x", "y", "yaw")):
        raise RuntimeError("Invalid pose")
    if telemetry.get("ms") is None:
        raise RuntimeError("Board telemetry unavailable")
    return pose, telemetry


def main():
    out = (Path(__file__).resolve().parents[1] / "tuning_reports" /
           (time.strftime("return_home_%Y%m%d_%H%M%S") +
            f"_{time.time_ns() % 1000000:06d}"))
    out.mkdir(parents=True)
    result = {"target": TARGET, "samples": []}
    last_ms = None
    last_wall = time.monotonic()
    started = None
    try:
        command("stop")
        pose, tel = state()
        result["start"] = pose
        if not 1.7 <= pose["x"] <= 2.3 or abs(pose["y"]) > .25:
            raise RuntimeError("Robot not at the expected post-trial location")
        if any(abs(value) > .1 for value in tel.get("pwm", [])):
            raise RuntimeError("PWM not zero before return")
        # A serial backlog previously made an active trial see old poses.
        t0 = time.monotonic()
        ms0 = tel["ms"]
        time.sleep(.5)
        pose, tel = state()
        elapsed = time.monotonic()-t0
        if not .75*elapsed <= (tel["ms"]-ms0)/1000.0 <= 1.30*elapsed:
            raise RuntimeError("Telemetry not real-time")
        last_ms, last_wall = tel["ms"], time.monotonic()

        command("pos_pid_x", kp=5, ki=0, kd=.1)
        command("pos_pid_y", kp=6, ki=0, kd=.1)
        command("yaw_pid", kp=9.5, kd=.4, maximum=1.5)
        command("pos_speed", linear=.35, angular=1.5)
        command("goal", **TARGET)
        started = time.monotonic()
        stable_since = None
        last_heartbeat = started
        previous_x = result["start"]["x"]
        last_progress = started
        while True:
            now = time.monotonic()
            if now-started > 25:
                raise RuntimeError("Return-home timeout")
            pose, tel = state()
            board_step = (tel["ms"]-last_ms)/1000.0
            wall_step = now-last_wall
            if board_step < 0 or board_step > 1.30*wall_step + .08:
                raise RuntimeError("Board reset or telemetry replay")
            if tel["ms"] != last_ms:
                last_ms, last_wall = tel["ms"], now
            if now-last_wall > .3:
                raise RuntimeError("Telemetry stale")
            x, y, yaw = pose["x"], pose["y"], pose["yaw"]
            result["samples"].append({"t": now-started, "pose": pose,
                                      "pwm": tel.get("pwm"), "rpm": tel.get("rpm"),
                                      "board_ms": tel["ms"]})
            if x < -.06 or x > result["start"]["x"] + .08 or abs(y) > .3 or abs(yaw) > .35:
                raise RuntimeError(f"Path trip x={x:.3f} y={y:.3f} yaw={yaw:.3f}")
            if x < previous_x - .005:
                last_progress = now
            if x > .10 and now-last_progress > 3:
                raise RuntimeError("No homeward progress for 3 s")
            previous_x = x
            if math.hypot(x, y) < .03 and abs(yaw) < math.radians(1):
                stable_since = stable_since or now
                if now-stable_since > 1:
                    command("stop")
                    break
            else:
                stable_since = None
            if now-last_heartbeat > .25:
                command("goal", **TARGET)
                last_heartbeat = now
            time.sleep(.05)

        stop_pose, _ = state()
        until = time.monotonic() + 5
        while time.monotonic() < until:
            pose, tel = state()
            result["samples"].append({"t": time.monotonic()-started,
                                      "pose": pose, "pwm": tel.get("pwm"),
                                      "rpm": tel.get("rpm"), "board_ms": tel["ms"],
                                      "after_stop": True})
            if math.hypot(pose["x"]-stop_pose["x"], pose["y"]-stop_pose["y"]) > .03:
                raise RuntimeError("More than 3 cm drift after STOP")
            time.sleep(.1)
        result["final"] = pose
    except (Exception, KeyboardInterrupt) as exc:
        result["fault"] = str(exc) or "interrupted"
    finally:
        try:
            command("stop")
        except Exception as exc:
            result["stop_error"] = str(exc)
        # Restore the conservative position defaults without enabling motion.
        for action, values in (("pos_pid_x", {"kp": 3, "ki": 0, "kd": .1}),
                               ("pos_pid_y", {"kp": 3, "ki": 0, "kd": .1}),
                               ("pos_speed", {"linear": .35, "angular": 1.5})):
            try:
                command(action, **values)
            except Exception as exc:
                result.setdefault("restore_errors", []).append(f"{action}: {exc}")
        (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"report": str(out), **{key: value for key, value in result.items()
                                             if key != "samples"}}, indent=2))
    return 1 if result.get("fault") or result.get("stop_error") else 0


if __name__ == "__main__":
    raise SystemExit(main())
