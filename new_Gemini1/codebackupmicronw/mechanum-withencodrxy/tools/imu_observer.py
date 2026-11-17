#!/usr/bin/env python3
"""Passive backend observer: GET only; never opens serial or commands motors.

Logs parsed telemetry and the backend's most recent decoded serial line.
This is NOT a lossless raw serial capture or a voltage measurement.
"""
import argparse
import datetime
import json
import time
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--duration", type=float, default=900)
    args = parser.parse_args()
    pose_cursor = telemetry_cursor = 0
    deadline = time.monotonic() + args.duration
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation prevents overwriting earlier evidence.
    with args.output.open("x", encoding="utf-8", buffering=1) as log:
        print(f"Passive GET-only capture started: {args.output}", flush=True)
        while time.monotonic() < deadline:
            record = {
                "utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "host_monotonic": time.monotonic(),
            }
            try:
                url = ("http://127.0.0.1:8001/api/tuner/state"
                       f"?pose_after={pose_cursor}&telemetry_after={telemetry_cursor}")
                with urllib.request.urlopen(url, timeout=2) as response:
                    state = json.load(response)
                record["state"] = state
                next_pose = state.get("pose_sequence", 0)
                next_tel = state.get("telemetry_sequence", 0)
                record["sequence_restarted"] = (
                    next_pose < pose_cursor or next_tel < telemetry_cursor
                )
                pose_cursor = next_pose if next_pose >= pose_cursor else 0
                telemetry_cursor = next_tel if next_tel >= telemetry_cursor else 0
            except Exception as error:
                record["read_error"] = str(error)
            log.write(json.dumps(record, ensure_ascii=True, allow_nan=False) + "\n")
            time.sleep(0.25)
        print("Capture complete; no commands sent.", flush=True)


if __name__ == "__main__":
    main()
