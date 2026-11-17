#!/usr/bin/env python3
"""One supervised, bounded loaded-yaw trial; never automatically sweeps gains."""
import argparse
import csv
import json
import math
from pathlib import Path
import time

import serial


def wrap(value):
    return math.atan2(math.sin(value), math.cos(value))


def main():
    ap = argparse.ArgumentParser(__doc__)
    ap.add_argument('--port', default='/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0')
    ap.add_argument('--kp', type=float, default=3.5)
    ap.add_argument('--kd', type=float, default=.2)
    ap.add_argument('--max-wz', type=float, default=.2)
    ap.add_argument('--step-deg', type=float, default=15)
    ap.add_argument('--seconds', type=float, default=6)
    ap.add_argument('--run', action='store_true', help='Explicitly enable physical rotation')
    args = ap.parse_args()
    if not args.run:
        ap.error('--run is required for physical motion')
    if not (0 < abs(args.step_deg) <= 15 and 0 < args.max_wz <= .3 and
            0 <= args.kp <= 8 and 0 <= args.kd <= 2 and 0 < args.seconds <= 10):
        ap.error('Trial exceeds supervised bounds')

    folder = Path(__file__).resolve().parents[1] / 'tuning_reports' / time.strftime('yaw_%Y%m%d_%H%M%S')
    folder.mkdir(parents=True, exist_ok=False)
    rows, raw = [], []
    pose = tel = None
    last_pose = last_tel = 0
    fault, stop_confirmed = None, False
    goal = initial = None
    start = None
    link = serial.Serial(args.port, 115200, timeout=.03, write_timeout=.2, exclusive=True)

    def send(command):
        link.write((command + '\n').encode('ascii'))

    def receive():
        nonlocal pose, tel, last_pose, last_tel
        text = link.readline().decode('ascii', errors='ignore').strip()
        now = time.monotonic()
        if text:
            raw.append((now, text))
        try:
            v = text.split(':')
            if text.startswith('T:POSE:') and len(v) == 10:
                pose = dict(x=float(v[2]), y=float(v[3]), yaw=float(v[4]), imu=bool(int(v[9])))
                last_pose = now
                if start is not None and tel is not None:
                    rows.append(dict(t=now-start, yaw=pose['yaw'], goal=goal,
                                     error=wrap(goal-pose['yaw']), x=pose['x'], y=pose['y'],
                                     **tel))
            elif text.startswith('T:TEL:') and len(v) == 21:
                tel = dict(ms=int(v[2]))
                for index, name in enumerate(('FL', 'FR', 'RL', 'RR')):
                    tel[name+'_rpm'] = float(v[5+index])
                    tel[name+'_ticks'] = int(v[13+index])
                    tel[name+'_pwm'] = float(v[17+index])
                last_tel = now
        except ValueError:
            pass
        return text

    def command(command_text, ack):
        send(command_text)
        until = time.monotonic()+1.2
        while time.monotonic() < until:
            text = receive()
            if text == ack:
                return
            if text.startswith('T:ERR:'):
                raise RuntimeError(text)
        raise RuntimeError('No ACK: ' + command_text)

    try:
        command('T:STOP', 'T:ACK:STOP')
        until = time.monotonic()+1.5
        while time.monotonic() < until:
            receive()
        if pose is None or tel is None or not pose['imu'] or time.monotonic()-last_pose > .5:
            raise RuntimeError('Fresh IMU/encoder telemetry required')
        if any(abs(tel[w+'_pwm']) > .1 for w in ('FL', 'FR', 'RL', 'RR')):
            raise RuntimeError('Motors did not stop before trial')
        command(f'T:YAW_PID:{args.kp}:{args.kd}:{args.max_wz}', 'T:ACK:YAW_PID')
        command(f'T:POS_SPEED:0.05:{args.max_wz}', 'T:ACK:POS_SPEED')
        initial = dict(pose)
        goal = wrap(initial['yaw']+math.radians(args.step_deg))
        goal_cmd = f"T:GOAL:{initial['x']:.5f}:{initial['y']:.5f}:{goal:.6f}"
        start = time.monotonic()
        command(goal_cmd, 'T:ACK:GOAL')
        heartbeat = time.monotonic()
        stalled_since = {w: None for w in ('FL', 'FR', 'RL', 'RR')}
        previous_ms = tel['ms']
        while time.monotonic()-start < args.seconds:
            text = receive()
            now = time.monotonic()
            if text.startswith('T:ERR:'):
                raise RuntimeError(text)
            if now-last_pose > .5 or now-last_tel > .5 or not pose['imu']:
                raise RuntimeError('Lost IMU/encoder telemetry')
            if tel['ms'] < previous_ms:
                raise RuntimeError('MCU restarted')
            previous_ms = tel['ms']
            progress = math.degrees(wrap(pose['yaw']-initial['yaw'])) * math.copysign(1, args.step_deg)
            if progress < -5 or progress > abs(args.step_deg)+10:
                raise RuntimeError(f'Unexpected yaw excursion: {progress:.2f} deg')
            if math.hypot(pose['x']-initial['x'], pose['y']-initial['y']) > .08:
                raise RuntimeError('XY drift exceeded 8 cm')
            for wheel in stalled_since:
                stalled = abs(tel[wheel+'_pwm']) > 90 and abs(tel[wheel+'_rpm']) < 2
                stalled_since[wheel] = (stalled_since[wheel] or now) if stalled else None
                if stalled_since[wheel] is not None and now-stalled_since[wheel] > .7:
                    raise RuntimeError(wheel+' has PWM >90 but <2 RPM for 0.7 s')
            if now-heartbeat >= .25:
                send(goal_cmd)
                heartbeat = now
    except (Exception, KeyboardInterrupt) as error:
        fault = str(error) or 'Interrupted'
    finally:
        try:
            for _ in range(3):
                send('T:STOP')
                time.sleep(.03)
            until = time.monotonic()+.8
            while time.monotonic() < until:
                receive()
            stop_confirmed = tel is not None and time.monotonic()-last_tel < .5 and all(
                abs(tel[w+'_pwm']) < .1 for w in ('FL', 'FR', 'RL', 'RR'))
        finally:
            link.close()

    result = dict(parameters=vars(args), fault=fault, stop_confirmed=stop_confirmed,
                  samples=len(rows), initial=initial, goal=goal,
                  note='PWM plots include the final STOP; no smoothing applied to yaw.')
    active_rows = [r for r in rows if 0 <= r['t'] <= args.seconds]
    if active_rows:
        direction = math.copysign(1, args.step_deg)
        progress = [math.degrees(wrap(r['yaw']-initial['yaw']))*direction for r in active_rows]
        result['overshoot_deg'] = max(0, max(progress)-abs(args.step_deg))
        result['final_error_deg'] = math.degrees(active_rows[-1]['error'])
        result['time_to_90_percent_s'] = next((r['t'] for r,p in zip(active_rows,progress)
                                               if p >= .9*abs(args.step_deg)), None)
        result['tick_delta'] = {w: active_rows[-1][w+'_ticks']-active_rows[0][w+'_ticks']
                                for w in ('FL','FR','RL','RR')}
    (folder/'result.json').write_text(json.dumps(result, indent=2)+'\n')
    (folder/'serial.log').write_text('\n'.join(f'{t:.6f} {line}' for t,line in raw)+'\n')
    if rows:
        with (folder/'samples.csv').open('w') as file:
            writer=csv.DictWriter(file, fieldnames=list(rows[0]))
            writer.writeheader(); writer.writerows(rows)
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        fig, axes = plt.subplots(3, 1, figsize=(11, 9), sharex=True)
        t=[r['t'] for r in rows]
        axes[0].plot(t, [math.degrees(wrap(r['yaw']-initial['yaw'])) for r in rows], label='Measured yaw')
        axes[0].axhline(args.step_deg, color='black', linestyle='--', label='Target')
        axes[0].set_ylabel('Relative yaw (deg)')
        for w in ('FL','FR','RL','RR'):
            axes[1].plot(t,[r[w+'_rpm'] for r in rows],label=w)
            axes[2].plot(t,[r[w+'_pwm'] for r in rows],label=w)
        axes[1].set_ylabel('Encoder speed (RPM)')
        axes[2].set_ylabel('Motor PWM')
        axes[2].set_xlabel('Time (s)')
        for ax in axes:
            ax.legend(); ax.grid(alpha=.3)
        fig.suptitle(f'Loaded yaw: P={args.kp}, D={args.kd}, max={args.max_wz} rad/s\n'+(fault or 'Completed'))
        fig.tight_layout(); fig.savefig(folder/'response.png', dpi=150); plt.close(fig)
    print(json.dumps(dict(report=str(folder), **result), indent=2))
    return 1 if fault or not stop_confirmed else 0


if __name__ == '__main__':
    raise SystemExit(main())
