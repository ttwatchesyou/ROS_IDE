#!/usr/bin/env python3
"""Build auditable profile evidence and raw-yaw plots. Does not move hardware."""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import re


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--since', required=True, help='first yaw_web_YYYYMMDD_HHMMSS in this session')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    profiles = re.findall(r'\{([\d.]+)f, ([\d.]+)f, ([\d.]+)f, (true|false)\}',
                          (root / 'include/yaw_profiles.h').read_text())
    trials = []
    for path in sorted((root / 'tuning_reports').glob('yaw_web_*/result.json')):
        if path.parent.name < args.since:
            continue
        data = json.loads(path.read_text())
        trials.append((path.parent, data))
    report = {'controller': 'yaw PD (Ki=0)', 'command_targets_deg': [0, 90, 0],
              'speed_unit': 'rad/s (command ceiling)', 'profiles': [],
              'note': 'These trials used the board firmware before restored source was uploaded. Values are candidates for the restored source, not yet validated on it. Times include 1 second of settling observation.',
              'wheel_config_sha256': hashlib.sha256((root/'include/wheel_config.h').read_bytes()).hexdigest()}
    for speed, kp, kd, validated in profiles:
        speed, kp, kd = map(float, (speed, kp, kd))
        matches = [(p, d) for p, d in trials if not d.get('fault') and
                   d['parameters']['max_wz'] == speed and
                   d['parameters']['kp'] == kp and d['parameters']['kd'] == kd and
                   all(leg in d for leg in ('outbound', 'return'))]
        selected = matches[-3:]
        if len(selected) != 3 or any(
                d[leg]['overshoot_deg'] > .2 or abs(d[leg]['final_error_deg']) > .85
                for _, d in selected for leg in ('outbound', 'return')):
            raise ValueError(f'{speed} profile lacks three passing cycles')
        entry = {'speed_radps': speed, 'kp': kp, 'ki': 0, 'kd': kd,
                 'validated_on_target_source': validated == 'true',
                 'cycles': [{'report': str(p.relative_to(root)),
                             'outbound': d['outbound'], 'return': d['return']}
                            for p, d in selected]}
        report['profiles'].append(entry)
    out = root / 'tuning_reports' / ('profiles_' + args.since.removeprefix('yaw_web_'))
    out.mkdir(exist_ok=True)
    (out/'profiles.json').write_text(json.dumps(report, indent=2)+'\n')
    with (out/'profiles.csv').open('w') as handle:
        writer = csv.writer(handle)
        writer.writerow(['speed_radps', 'kp', 'ki', 'kd', 'leg', 'time_s',
                         'overshoot_deg', 'final_error_deg', 'peak_actual_radps', 'report'])
        for entry in report['profiles']:
            for cycle in entry['cycles']:
                for leg in ('outbound', 'return'):
                    m = cycle[leg]
                    writer.writerow([entry['speed_radps'], entry['kp'], 0, entry['kd'], leg,
                                     m['time_s'], m['overshoot_deg'], m['final_error_deg'],
                                     m['peak_yaw_rate_radps'], cycle['report']])
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    if not report['profiles']:
        raise ValueError('No validated profiles')
    fig, axes = plt.subplots(len(report['profiles']), 2,
                             figsize=(12, 3*len(report['profiles'])), squeeze=False)
    for row, entry in enumerate(report['profiles']):
        for col, leg in enumerate(('0_to_90', '90_to_0')):
            ax = axes[row, col]
            for cycle in entry['cycles']:
                samples = json.loads((root/cycle['report']/'pose_samples.json').read_text())
                samples = [s for s in samples if s['leg'] == leg]
                if samples:
                    ax.plot([s['t']-samples[0]['t'] for s in samples],
                            [math.degrees(s['yaw']) for s in samples], linewidth=1)
            ax.axhline(90 if col == 0 else 0, color='black', linestyle='--', linewidth=.8)
            ax.set(title=f"{entry['speed_radps']} rad/s | P={entry['kp']}, D={entry['kd']} | {leg}",
                   xlabel='board time (s)', ylabel='raw IMU yaw (degrees)')
            ax.grid(alpha=.3)
    fig.tight_layout()
    fig.savefig(out/'yaw_profiles.png', dpi=150)
    plt.close(fig)
    print(out)


if __name__ == '__main__':
    main()
