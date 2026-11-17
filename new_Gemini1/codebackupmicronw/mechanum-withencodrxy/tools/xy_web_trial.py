#!/usr/bin/env python3
"""Supervised single-axis position/yaw trial through the dashboard API.

All goal coordinates are relative to the measured starting position. A trial
commands +distance (or -distance) on one axis, then returns to its start.
The robot CENTER may travel within a 1 x 1 m square. The robot must start
physically centered in that square before --run; odometry cannot verify this.
"""
import argparse
import json
import math
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


# The user defined 1 x 1 m of available ROBOT-CENTER travel, not a 1 x 1 m
# floor opening containing the chassis. Start at its center; reserve 5 cm
# on every edge for the software fault trip, and a further 5 cm between the
# commanded goal and that trip. These numbers cannot guarantee stopping.
WORKSPACE_CENTER_SIDE_M = 1.0
YAW_TRIP_DEG = 8.0
BOUNDARY_MARGIN_M = 0.05
CENTER_TRIP_M = WORKSPACE_CENTER_SIDE_M / 2 - BOUNDARY_MARGIN_M
MAX_GOAL_DISTANCE_M = CENTER_TRIP_M - 0.05
# The firmware braking envelope is sqrt(2 * 0.25 * (distance - 0.01)).
# A 0.40 m axis leg cannot reach even 0.45 m/s, so reject misleading trials
# whose requested speed is above the physically commanded envelope.
BRAKING_DECELERATION_MPS2 = 0.25
POSITION_TOLERANCE_M = 0.01


def attainable_speed_cap(distance_m):
    return math.sqrt(2 * BRAKING_DECELERATION_MPS2 *
                     max(abs(distance_m) - POSITION_TOLERANCE_M, 0.0))


def wrap(radians):
    return math.atan2(math.sin(radians), math.cos(radians))


def api(base, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = Request(base + path, data=data,
                      headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=2) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(error.read().decode(errors="replace")) from error


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--axis", choices=("x", "y"), required=True)
    parser.add_argument("--distance", type=float, required=True,
                        help="signed distance from centered start, metres; max 0.40 in 1 x 1 m center travel")
    parser.add_argument("--speed", type=float, required=True,
                        help="maximum linear command, m/s; max ~0.44 for a 0.40 m leg")
    parser.add_argument("--kp", type=float, required=True)
    parser.add_argument("--ki", type=float, default=0.0)
    parser.add_argument("--kd", type=float, required=True)
    parser.add_argument("--cross-kp", type=float, default=1.0,
                        help="orthogonal-axis position P gain")
    parser.add_argument("--cross-ki", type=float, default=0.0)
    parser.add_argument("--cross-kd", type=float, default=0.1)
    parser.add_argument("--yaw-kp", type=float, required=True)
    parser.add_argument("--yaw-kd", type=float, required=True)
    parser.add_argument("--yaw-max", type=float, default=1.0)
    parser.add_argument("--yaw-target", type=float, default=None,
                        help="fixed absolute heading in radians; default is heading at trial start")
    parser.add_argument("--firmware-defaults", action="store_true",
                        help="do not send PID/speed settings; verify the flashed defaults")
    parser.add_argument("--allow-unattained-cap", action="store_true",
                        help="log a requested cap above the braking envelope as a diagnostic, not a validated speed")
    parser.add_argument("--base", default="http://127.0.0.1:8001")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--robot-centered", action="store_true",
                        help="assert robot center starts at the middle of its clear 1 x 1 m travel area")
    parser.add_argument("--workspace-origin-at-center", action="store_true",
                        help="assert pose 0,0 is the physical center of the 1 x 1 m travel area")
    parser.add_argument("--verified-corridor", action="store_true",
                        help="assert a clear forward corridor beyond a 1 m X goal with stopping margin")
    parser.add_argument("--one-way", action="store_true",
                        help="STOP at the outbound goal; do not command the return leg")
    args = parser.parse_args()
    if not args.run:
        parser.error("--run required for physical motion")
    if not (args.robot_centered or args.workspace_origin_at_center or args.verified_corridor):
        parser.error("assert either a centered robot or a workspace-centered pose origin")
    if args.verified_corridor and (args.axis != "x" or not args.one_way or
                                   not (args.distance == 1.0 or -1.03 <= args.distance <= -.90)):
        parser.error("verified-corridor mode is only for one X leg to 1 m or back to zero")
    distance_limit = 1.03 if args.verified_corridor else MAX_GOAL_DISTANCE_M
    effective_speed_cap = attainable_speed_cap(args.distance)
    if not (0 < abs(args.distance) <= distance_limit and
            0 < args.speed <= (2.0 if args.allow_unattained_cap else effective_speed_cap) and
            0 <= args.kp <= 10 and 0 <= args.ki <= 10 and 0 <= args.kd <= 5 and
            0 <= args.cross_kp <= 10 and 0 <= args.cross_ki <= 10 and 0 <= args.cross_kd <= 5 and
            0 <= args.yaw_kp <= 10 and 0 <= args.yaw_kd <= 5 and
            0 < args.yaw_max <= 3 and
            (args.yaw_target is None or -math.pi <= args.yaw_target <= math.pi)):
        parser.error("trial outside bounded gains, attainable speed or 1 x 1 m center travel")

    out = (Path(__file__).resolve().parents[1] / "tuning_reports" /
           (time.strftime("xy_%Y%m%d_%H%M%S") + f"_{time.time_ns() % 1000000:06d}"))
    out.mkdir(parents=True)
    result = {"parameters": vars(args), "attainable_command_cap_mps": effective_speed_cap,
              "requested_cap_reached_by_envelope": args.speed <= effective_speed_cap,
              "legs": []}
    samples = []
    motor_samples = []
    last_board_ms = None
    last_board_update = time.monotonic()
    last_pose_sequence = None
    last_pose_update = time.monotonic()
    cursor = 0

    def state():
        nonlocal last_board_ms, last_board_update, last_pose_sequence, last_pose_update, cursor
        current = api(args.base, f"/api/tuner/state?pose_after={cursor}")
        pose = current.get("pose") or {}
        telemetry = current.get("telemetry") or {}
        if not current.get("connected") or not pose.get("imu_ok"):
            raise RuntimeError("USB or IMU unavailable")
        if not all(math.isfinite(pose.get(k, float("nan"))) for k in ("x", "y", "yaw")):
            raise RuntimeError("Invalid position/yaw telemetry")
        board_ms = telemetry.get("ms")
        if board_ms is None or (last_board_ms is not None and board_ms < last_board_ms):
            raise RuntimeError("STM32 telemetry missing or board restarted")
        if board_ms != last_board_ms:
            last_board_ms, last_board_update = board_ms, time.monotonic()
        if time.monotonic() - last_board_update > .3:
            raise RuntimeError("STM32 telemetry stale")
        pose_sequence = current.get("pose_sequence")
        if pose_sequence is None or (last_pose_sequence is not None and pose_sequence < last_pose_sequence):
            raise RuntimeError("STM32 pose stream missing or restarted")
        if pose_sequence != last_pose_sequence:
            last_pose_sequence, last_pose_update = pose_sequence, time.monotonic()
        if time.monotonic() - last_pose_update > .5:
            raise RuntimeError("STM32 pose stream stale")
        history = current.get("pose_samples", [])
        if history:
            cursor = max(cursor, max(row["seq"] for row in history))
        return current, history

    def command(action, **values):
        for attempt in range(2):
            try:
                response = api(args.base, "/api/tuner/command", {"action": action, **values})
                break
            except RuntimeError as error:
                # The CH340 link can lose an ACK while executing the command.
                # These frames are idempotent, so one bounded retry is safe.
                if attempt or "did not acknowledge" not in str(error):
                    raise
                time.sleep(.1)
        if response.get("status") != "ok":
            raise RuntimeError(f"{action} rejected: {response}")
        return response

    origin = None
    last_target = None
    try:
        command("stop")
        current, _ = state()
        if any(abs(v) > .1 for v in current["telemetry"].get("pwm", [])):
            raise RuntimeError("Motor PWM was not zero at start")
        origin = current["pose"]
        if args.verified_corridor:
            if args.distance > 0 and max(abs(origin["x"]), abs(origin["y"])) > .05:
                raise RuntimeError("Forward corridor trial requires pose near 0,0")
            if args.distance < 0 and (not .90 <= origin["x"] <= 1.03 or abs(origin["y"]) > .05 or
                                       abs(origin["x"] + args.distance) > .03):
                raise RuntimeError("Return corridor trial requires pose near 1,0 and a goal near X=0")
        if args.workspace_origin_at_center:
            planned_axis_goal = origin[args.axis] + args.distance
            if (max(abs(origin["x"]), abs(origin["y"])) > CENTER_TRIP_M or
                    abs(planned_axis_goal) > MAX_GOAL_DISTANCE_M):
                raise RuntimeError("Current pose or planned goal outside 1 x 1 m center-travel guard")
        heading = origin["yaw"] if args.yaw_target is None else args.yaw_target
        cursor = current.get("pose_sequence", 0)
        if not args.firmware_defaults:
            if args.axis == "x":
                command("pos_pid_x", kp=args.kp, ki=args.ki, kd=args.kd)
                command("pos_pid_y", kp=args.cross_kp, ki=args.cross_ki, kd=args.cross_kd)
            else:
                command("pos_pid_x", kp=args.cross_kp, ki=args.cross_ki, kd=args.cross_kd)
                command("pos_pid_y", kp=args.kp, ki=args.ki, kd=args.kd)
            command("yaw_pid", kp=args.yaw_kp, kd=args.yaw_kd, maximum=args.yaw_max)
            command("pos_speed", linear=args.speed, angular=args.yaw_max)
        target = {"x": origin["x"], "y": origin["y"], "yaw": heading}
        # Discard telemetry collected while setting up gains. Each leg then
        # measures only motion after its own command.
        setup_state, _ = state()
        cursor = setup_state.get("pose_sequence", cursor)

        def leg(name, distance):
            nonlocal last_target, cursor
            leg_state, _ = state()
            cursor = leg_state.get("pose_sequence", cursor)
            began = time.monotonic()
            last_heartbeat = 0.0
            stable_at = None
            peak_error = 0.0
            peak_yaw_deg = 0.0
            peak_off_axis = 0.0
            peak_speed = 0.0
            previous = None
            previous_drive_ticks = None
            last_drive_tick_at = began
            start_position = leg_state["pose"][args.axis]
            direction = 1 if origin[args.axis]+distance >= start_position else -1
            best_forward = 0.0
            last_progress_at = began
            target[args.axis] = origin[args.axis] + distance
            last_target = dict(target)
            while time.monotonic() - began < 20:
                now = time.monotonic()
                current, history = state()
                pose = current["pose"]
                telemetry = current.get("telemetry") or {}
                drive_ticks = telemetry.get("ticks")
                if isinstance(drive_ticks, list) and len(drive_ticks) == 4:
                    if previous_drive_ticks is None or drive_ticks != previous_drive_ticks:
                        last_drive_tick_at = now
                    previous_drive_ticks = drive_ticks
                motor_samples.append({
                    "leg": name, "t": now-began, "board_ms": telemetry.get("ms"),
                    "rpm": telemetry.get("rpm"), "raw_rpm": telemetry.get("raw_rpm"),
                    "target_rpm": telemetry.get("target_rpm"),
                    "pwm": telemetry.get("pwm"), "ticks": telemetry.get("ticks"),
                    "x": pose["x"], "y": pose["y"], "yaw": pose["yaw"],
                })
                for row in history:
                    x, y, yaw = row["x"], row["y"], row["yaw"]
                    rx, ry = ((x, y) if args.workspace_origin_at_center or args.verified_corridor else
                              (x-origin["x"], y-origin["y"]))
                    yaw_deg = abs(math.degrees(wrap(yaw-heading)))
                    # These are software fault trips, not guarantees that a
                    # moving robot can brake before a physical boundary.
                    if args.verified_corridor:
                        if rx < -.05 or rx > 1.03 or abs(ry) > .10:
                            raise RuntimeError(f"1-m corridor trip: x={rx:.3f} y={ry:.3f}")
                    elif max(abs(rx), abs(ry)) > CENTER_TRIP_M:
                        raise RuntimeError(f"Robot center crossed {CENTER_TRIP_M:.3f} m workspace trip: x={rx:.3f} y={ry:.3f}")
                    if yaw_deg > YAW_TRIP_DEG:
                        raise RuntimeError(f"Yaw drift exceeded {YAW_TRIP_DEG:g} deg: {yaw_deg:.2f}")
                    off_axis = abs(y-origin["y"] if args.axis == "x" else x-origin["x"])
                    if off_axis > .15:
                        raise RuntimeError(f"Off-axis drift exceeded 15 cm: {off_axis:.3f} m")
                    peak_yaw_deg = max(peak_yaw_deg, yaw_deg)
                    peak_off_axis = max(peak_off_axis, off_axis)
                    progress = (x-origin["x"] if args.axis == "x" else y-origin["y"])
                    peak_error = max(peak_error, max(0., (progress-distance)*direction))
                    if peak_error > .04:
                        raise RuntimeError(
                            f"Goal overshoot exceeded 4 cm: {peak_error:.3f} m")
                    if name != "align_heading":
                        forward = (row[args.axis]-start_position)*direction
                        if forward > best_forward + .005:
                            best_forward = forward
                            last_progress_at = now
                        if forward < -.05:
                            raise RuntimeError(f"Motion opposite goal by {-forward:.3f} m")
                        if best_forward-forward > .05:
                            raise RuntimeError(f"Motion reversed by {best_forward-forward:.3f} m before settling")
                        if abs(target[args.axis]-row[args.axis]) > .08 and now-last_progress_at > 2:
                            raise RuntimeError("No goal progress for 2 s; stopped before possible reversal")
                    if previous is not None and row["t"] > previous["t"]:
                        sample_dt = row["t"]-previous["t"]
                        axis_step = abs(row[args.axis]-previous[args.axis])
                        cross_axis = "y" if args.axis == "x" else "x"
                        cross_step = abs(row[cross_axis]-previous[cross_axis])
                        # The passive odometry X reading has jumped ~4 cm
                        # while every drive-wheel tick counter was stationary.
                        # Whether the chassis slipped or the measurement was
                        # wrong, that segment must not be used for PID tuning.
                        if (axis_step > .03 or cross_step > .03) and now-last_drive_tick_at > .3:
                            raise RuntimeError(
                                f"Pose moved {max(axis_step, cross_step):.3f} m while drive ticks were stationary")
                        # A several-centimetre instantaneous orthogonal jump
                        # is not useful evidence for PID selection. Stop the
                        # trial rather than letting the controller chase it.
                        if (cross_step > max(.02, effective_speed_cap*sample_dt*1.5) or
                                axis_step > max(.04, effective_speed_cap*sample_dt*2.0)):
                            raise RuntimeError(
                                f"Odometry jump: {args.axis}={axis_step:.3f} m, "
                                f"{cross_axis}={cross_step:.3f} m in {sample_dt:.3f} s")
                        velocity = math.hypot(x-previous["x"], y-previous["y"])/sample_dt
                        peak_speed = max(peak_speed, velocity)
                        if velocity > 2.5:
                            raise RuntimeError(f"Measured planar speed too high: {velocity:.2f} m/s")
                    previous = row
                    samples.append({"leg": name, "goal": dict(target), **row})
                if now-last_heartbeat >= .25:
                    command("goal", **target)
                    last_heartbeat = now
                error = math.hypot(target["x"]-pose["x"], target["y"]-pose["y"])
                yaw_error = abs(math.degrees(wrap(target["yaw"]-pose["yaw"])))
                # The API publishes pose at ~10 Hz, while this loop polls at
                # ~20 Hz. An empty *new-samples* batch between two updates
                # is normal and must not reset the 1-second settle timer.
                # state() separately rejects a stale pose stream.
                if error <= .03 and yaw_error <= 1.0:
                    stable_at = stable_at or now
                    if now-stable_at >= 1:
                        command("stop")
                        stopped_x, stopped_y = pose["x"], pose["y"]
                        post_stop_drift = 0.0
                        until = time.monotonic() + 5.0
                        while time.monotonic() < until:
                            coast_state, coast_history = state()
                            for row in coast_history:
                                samples.append({"leg": name+"_after_stop", "goal": dict(target), **row})
                            coast = coast_state["pose"]
                            coast_telemetry = coast_state.get("telemetry") or {}
                            motor_samples.append({
                                "leg": name+"_after_stop", "t": time.monotonic()-began,
                                "board_ms": coast_telemetry.get("ms"),
                                "rpm": coast_telemetry.get("rpm"),
                                "raw_rpm": coast_telemetry.get("raw_rpm"),
                                "pwm": coast_telemetry.get("pwm"),
                                "ticks": coast_telemetry.get("ticks"),
                                "x": coast["x"], "y": coast["y"], "yaw": coast["yaw"],
                            })
                            post_stop_drift = max(post_stop_drift,
                                math.hypot(coast["x"]-stopped_x, coast["y"]-stopped_y))
                            if post_stop_drift > .02:
                                raise RuntimeError(
                                    f"Pose shifted {post_stop_drift:.3f} m after STOP")
                            time.sleep(.05)
                        return {"leg": name, "time_s": now-began,
                                "final_position_error_m": error,
                                "peak_overshoot_m": peak_error,
                                "peak_yaw_error_deg": peak_yaw_deg,
                                "peak_off_axis_m": peak_off_axis,
                                "peak_measured_speed_mps": peak_speed,
                                "post_stop_drift_m": post_stop_drift,
                                "post_stop_axis_shift_m": coast[args.axis] - pose[args.axis],
                                "post_stop_final_position_error_m": math.hypot(
                                    target["x"] - coast["x"], target["y"] - coast["y"])}
                else:
                    stable_at = None
                time.sleep(.05)
            raise RuntimeError(f"{name} did not settle in 20 s")

        if args.yaw_target is not None and abs(math.degrees(wrap(origin["yaw"]-heading))) > 1.0:
            result["legs"].append(leg("align_heading", 0.0))
            time.sleep(.4)
        result["legs"].append(leg("outbound", args.distance))
        if not args.one_way:
            time.sleep(.4)
            result["legs"].append(leg("return", 0.0))
    except (Exception, KeyboardInterrupt) as error:
        result["fault"] = str(error) or "interrupted"
    finally:
        restore_actions = [("stop", {})]
        if not args.firmware_defaults:
            restore_actions.extend([
                ("pos_pid_x", {"kp": 3, "ki": 0, "kd": .1}),
                ("pos_pid_y", {"kp": 3, "ki": 0, "kd": .1}),
                ("yaw_pid", {"kp": 9.5, "kd": .4, "maximum": 1.5}),
                ("pos_speed", {"linear": .35, "angular": 1.5}),
            ])
        restore_errors = []
        for action, values in restore_actions:
            try:
                command(action, **values)
            except Exception as error:
                # A transient UART parse error must not skip the remaining
                # STOP/restore steps. Every action in this list is idempotent.
                time.sleep(.1)
                try:
                    command(action, **values)
                except Exception as retry_error:
                    restore_errors.append(f"{action}: {retry_error}")
        if restore_errors:
            result.setdefault("fault", "STOP/restore command failed: " + "; ".join(restore_errors))
    result["origin"] = origin
    result["last_target"] = last_target
    (out/"result.json").write_text(json.dumps(result, indent=2)+"\n")
    (out/"pose_samples.json").write_text(json.dumps(samples)+"\n")
    (out/"motor_samples.json").write_text(json.dumps(motor_samples)+"\n")
    print(json.dumps({"report": str(out), **result}, indent=2))
    return bool(result.get("fault"))


if __name__ == "__main__":
    raise SystemExit(main())
