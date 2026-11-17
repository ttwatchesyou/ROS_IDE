#!/usr/bin/env python3
"""Run an Agent update only while a fresh Bool motor interlock remains true."""
import json
import os
import signal
import subprocess
import sys
import time

import rclpy
from rclpy.qos import QoSProfile, ReliabilityPolicy
from std_msgs.msg import Bool
from geometry_msgs.msg import Twist

topic, installer, origin, digest, version, state_file = sys.argv[1:]
last_true = None
stable_since = None
child = None
last_motion = time.monotonic()
motion_during_install = False


def stop_child():
    if child and child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=45)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


def record(stage, error=''):
    data = {'version': version, 'sha256': digest, 'stage': stage,
            'error': error, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    pending = state_file + '.pending'
    with open(pending, 'w', encoding='utf-8') as output:
        json.dump(data, output)
    os.chmod(pending, 0o600)
    os.replace(pending, state_file)


def on_signal(_number, _frame):
    stop_child()
    raise RuntimeError('Updater interrupted')


signal.signal(signal.SIGTERM, on_signal)
signal.signal(signal.SIGINT, on_signal)
rclpy.init()
node = rclpy.create_node('roside_agent_update_interlock')


def on_safety(message):
    global last_true, stable_since
    now = time.monotonic()
    if message.data:
        last_true = now
        if stable_since is None:
            stable_since = now
    else:
        last_true = None
        stable_since = None


def on_cmd_vel(message):
    global last_motion, motion_during_install
    components = (message.linear.x, message.linear.y, message.linear.z,
                  message.angular.x, message.angular.y, message.angular.z)
    if any(not (-0.000001 <= value <= 0.000001) for value in components):
        last_motion = time.monotonic()
        if child is not None:
            motion_during_install = True


node.create_subscription(Bool, topic, on_safety,
                         QoSProfile(depth=10, reliability=ReliabilityPolicy.BEST_EFFORT))
node.create_subscription(Twist, '/cmd_vel', on_cmd_vel,
                         QoSProfile(depth=20, reliability=ReliabilityPolicy.BEST_EFFORT))
try:
    record('waiting_safe')
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        rclpy.spin_once(node, timeout_sec=0.1)
        now = time.monotonic()
        if last_true is None or now - last_true > 1.5:
            stable_since = None
        if stable_since is not None and now - stable_since >= 3 and now - last_motion >= 3:
            break
    else:
        record('deferred', 'Motor interlock or /cmd_vel idle condition not met; retry on next check')
        sys.exit(0)
    record('installing')
    environment = dict(os.environ, CLOUD_URL=origin, ROSIDE_EXPECT_SHA256=digest,
                       ROSIDE_EXPECT_VERSION=version, ROSIDE_NONINTERACTIVE='1')
    child = subprocess.Popen(['/bin/bash', installer], env=environment, start_new_session=True)
    while child.poll() is None:
        rclpy.spin_once(node, timeout_sec=0.1)
        if last_true is None or time.monotonic() - last_true > 1.5:
            stop_child()
            subprocess.run(['systemctl', '--user', 'stop', 'ros2ide-agent'],
                           timeout=20, check=False)
            raise RuntimeError('Motor-disabled signal lost; Agent stopped. Restore the interlock and restart Agent manually')
        if motion_during_install:
            stop_child()
            subprocess.run(['systemctl', '--user', 'stop', 'ros2ide-agent'],
                           timeout=20, check=False)
            raise RuntimeError('Nonzero /cmd_vel received; Agent stopped. Check the motor interlock before restart')
    if child.returncode != 0:
        raise RuntimeError('Installer failed with exit status ' + str(child.returncode))
    record('ready')
except Exception as error:
    record('failed', str(error))
    raise
finally:
    node.destroy_node()
    rclpy.shutdown()
