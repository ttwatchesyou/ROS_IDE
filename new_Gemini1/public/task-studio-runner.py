"""ROSIDE Task Studio exported runtime. Dry-run by default; no dependency on Cloud."""
import hashlib
import json
import math
import time
import uuid
import threading
import queue
from concurrent.futures import ThreadPoolExecutor
from itertools import chain
from pathlib import Path

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
from std_msgs.msg import String, Bool
from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
from rosidl_runtime_py.utilities import get_message
from rosidl_runtime_py.convert import message_to_ordereddict
from ament_index_python.packages import get_package_share_directory


def resolve(value, env):
    return env[value[1:]] if isinstance(value, str) and value.startswith('$') else value


def blocks_in(program):
    def walk(blocks):
        for block in blocks:
            yield block
            yield from walk(block.get('body', []))
            yield from walk(block.get('elseBody', []))
            for branch in block.get('branches', []):
                yield from walk(branch)
    yield from walk(program['main'])
    for function in program['functions']:
        yield from walk(function['body'])


def events(program, blocks, env=None, stack=None, depth=0):
    if depth > 10:
        raise ValueError('Function/repeat nesting exceeds 10')
    env, stack = env or {}, stack or ['Main']
    for source in blocks:
        block = dict(source)
        for key in ('seconds', 'x', 'y', 'yaw', 'speed', 'timeout', 'count'):
            if key in block:
                block[key] = resolve(block[key], env)
        yield block, stack, env, 'enter'
        if block['type'] == 'call':
            function = next(f for f in program['functions'] if f['name'] == block['fn'])
            if block['fn'] in stack:
                raise ValueError('Recursive function call')
            args = dict(function['params'])
            args.update({k: resolve(v, env) for k, v in block['args'].items()})
            yield from events(program, function['body'], args, stack + [block['fn']], depth + 1)
        if block['type'] == 'repeat':
            count = block['count']
            if not isinstance(count, int) or not 1 <= count <= 100:
                raise ValueError('Repeat count must be 1..100')
            for index in range(count):
                yield from events(program, block['body'], env, stack + [f'Loop {index+1}/{count}'], depth + 1)
        yield block, stack, env, 'exit'


def condition(value, operator, expected):
    numeric = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
    same_type = type(value) is type(expected) or (numeric(value) and numeric(expected))
    if operator == '==':
        return same_type and value == expected
    if operator == '!=':
        return not same_type or value != expected
    if isinstance(value, bool) or isinstance(expected, bool) or not isinstance(value, (float, int)) or not isinstance(expected, (float, int)):
        return False
    return {'>': lambda: value > expected, '<': lambda: value < expected,
            '>=': lambda: value >= expected, '<=': lambda: value <= expected}[operator]()


def motion(pose, block):
    """Bounded differential-drive command in the fixed odom frame; not a planner."""
    x, y, yaw = pose
    for key in ('x', 'y', 'yaw', 'speed', 'timeout'):
        if not isinstance(block[key], (int, float)) or not math.isfinite(block[key]):
            raise ValueError('Non-finite motion parameter')
    if abs(block['x']) > 100 or abs(block['y']) > 100 or abs(block['yaw']) > 180 or not .01 <= block['speed'] <= .2 or not 1 <= block['timeout'] <= 600:
        raise ValueError('Motion limits invalid')
    distance = math.hypot(block['x']-x, block['y']-y)
    wrap = lambda a: math.atan2(math.sin(a), math.cos(a))
    error = wrap(math.atan2(block['y']-y, block['x']-x)-yaw) if distance > .05 else wrap(math.radians(block['yaw'])-yaw)
    done = distance <= .05 and abs(error) <= .08
    linear = min(block['speed'], distance*.6) if distance > .05 and abs(error) < .3 else 0.
    return (0., 0., True) if done else (linear, max(-.35, min(.35, error)), False)


class TaskRunner(Node):
    def __init__(self):
        super().__init__('task_studio_runner')
        path = Path(get_package_share_directory('__TASK_PACKAGE__')) / 'flows/task.flow.json'
        raw = path.read_text()
        self.program = json.loads(raw)
        self.program_hash = hashlib.sha256(raw.encode()).hexdigest()
        self.dry = self.declare_parameter('dry_run', True).value
        enabled = self.declare_parameter('motion_enabled', False).value
        if not self.dry and not enabled:
            raise RuntimeError('Real execution requires commissioned safety integration and motion_enabled')
        self.run_id, self.seq, self.history = uuid.uuid4().hex, 0, []
        self.active, self.current, self.phase, self.message = True, None, 'ready', 'Ready'
        self.iterator = events(self.program, self.program['main'])
        self.samples, self.subscribed = {}, {}
        self.cancel_workers = threading.Event()
        self.worker_events = queue.Queue(maxsize=256)
        self.workers = ThreadPoolExecutor(max_workers=2, thread_name_prefix='task-lane')
        self.futures, self.lanes, self.user_publishers = None, {}, {}
        self.topic_blocks = [b for b in blocks_in(self.program) if b['type'] in ('wait_topic', 'if_topic')]
        if not self.dry:
            for block in blocks_in(self.program):
                if block['type'] == 'publish':
                    self.validate_publish(block)
                    topic = block['topic']
                    if topic in self.user_publishers and self.user_publishers[topic][0] != block['msgType']:
                        raise ValueError('Conflicting message types for user topic')
                    if topic not in self.user_publishers:
                        self.user_publishers[topic] = (block['msgType'], self.create_publisher(get_message(block['msgType']), topic, 10))
        self.pose, self.pose_at, self.safety_at, self.safety_ok = None, 0., 0., False
        self.start_at, self.last_debug, self.event_count = time.monotonic(), 0., 0
        self.debug = self.create_publisher(String, '/task_studio/debug', 10)
        self.output = None
        self.lock_file = None
        if not self.dry and any(b['type'] == 'odom_position' for b in blocks_in(self.program)):
            # Host-local single owner. A separate command arbiter still owns robot-wide priority.
            import fcntl
            import os
            output_topic = self.resolve_topic_name('/task_studio/cmd_vel')
            key = hashlib.sha256(output_topic.encode()).hexdigest()[:24]
            lock_dir = Path.home() / '.roside_task_studio'
            lock_dir.mkdir(mode=0o700, exist_ok=True)
            self.lock_file = open(lock_dir / (key+'.lock'), 'a')
            fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if output_topic != '/task_studio/cmd_vel':
                raise RuntimeError('Do not remap motion output directly; use the safety arbiter')
            self.output = self.create_publisher(Twist, output_topic, 1)
        qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT, durability=DurabilityPolicy.VOLATILE)
        self.create_subscription(Odometry, '/odom', self.odom, qos)
        self.create_subscription(Bool, '/task_studio/safety_ready', self.safety, qos)
        self.create_subscription(Bool, '/task_studio/stop', lambda msg: self.finish('cancelled', 'Stop requested') if msg.data else None, 10)
        self.create_timer(.05, self.tick)

    def safety(self, msg):
        self.safety_at, self.safety_ok = time.monotonic(), bool(msg.data)

    def odom(self, msg):
        p, q = msg.pose.pose.position, msg.pose.pose.orientation
        values = [p.x, p.y, q.x, q.y, q.z, q.w]
        stamp = msg.header.stamp.sec + msg.header.stamp.nanosec / 1e9
        age = self.get_clock().now().nanoseconds / 1e9 - stamp
        norm = sum(v*v for v in (q.x, q.y, q.z, q.w))
        if msg.header.frame_id != 'odom' or not all(math.isfinite(v) for v in values) or not .8 <= norm <= 1.2 or not 0 <= age <= .5:
            self.pose = None
            return
        yaw = math.atan2(2*(q.w*q.z+q.x*q.y), 1-2*(q.y*q.y+q.z*q.z))
        now, pose = time.monotonic(), (p.x, p.y, yaw)
        if self.pose and now-self.pose_at < .5 and math.hypot(p.x-self.pose[0], p.y-self.pose[1]) > .5:
            self.finish('failed', 'ODOM discontinuity: check coordinate origin')
        self.pose, self.pose_at = pose, now

    def stop(self):
        if self.output:
            self.output.publish(Twist())

    def finish(self, phase, message):
        self.active, self.phase, self.message = False, phase, message
        if hasattr(self, 'cancel_workers'):
            self.cancel_workers.set()
        self.stop()
        self.report()

    def report(self):
        self.seq += 1
        event = {'seq': self.seq, 'step': self.current[0]['id'] if self.current else None,
                 'stack': self.current[1] if self.current else [], 'env': self.current[2] if self.current else {},
                 'phase': self.phase, 'message': self.message}
        self.history = (self.history+[event])[-16:]
        msg = String()
        msg.data = json.dumps({'program': self.program['name'], 'program_hash': self.program_hash,
                              'run_id': self.run_id, 'dry_run': self.dry, **event, 'history': self.history,
                              'lanes': getattr(self, 'lanes', {})})
        self.debug.publish(msg)
        self.last_debug = time.monotonic()

    def watch(self, topic, expected=None):
        if topic in self.subscribed:
            return
        types = dict(self.get_topic_names_and_types()).get(topic, [])
        if len(types) != 1:
            return
        if expected and types[0] != expected:
            raise ValueError('Topic message type mismatch: '+topic)
        publishers = self.get_publishers_info_by_topic(topic)
        transient = bool(publishers) and all(p.qos_profile.durability == DurabilityPolicy.TRANSIENT_LOCAL for p in publishers)
        qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT,
                         durability=DurabilityPolicy.TRANSIENT_LOCAL if transient else DurabilityPolicy.VOLATILE)
        def receive(msg):
            self.samples[topic] = (message_to_ordereddict(msg), time.monotonic())
        self.subscribed[topic] = self.create_subscription(get_message(types[0]), topic, receive, qos)

    @staticmethod
    def validate_publish(block):
        import re
        expected = {'std_msgs/msg/String': str, 'std_msgs/msg/Float64': (int, float), 'std_msgs/msg/Bool': bool}
        kind, value = block.get('msgType'), block.get('value')
        if not re.fullmatch(r'/task_studio/user/[A-Za-z_]\w*(/[A-Za-z_]\w*)*', block.get('topic', '')) or kind not in expected:
            raise ValueError('Publish is restricted to typed /task_studio/user/ topics')
        if not isinstance(value, expected[kind]) or (kind == 'std_msgs/msg/Float64' and (isinstance(value, bool) or not math.isfinite(value))) or (isinstance(value, str) and len(value) > 500):
            raise ValueError('Invalid publish value')

    def publish_user(self, block):
        self.validate_publish(block)
        if self.dry or self.cancel_workers.is_set():
            return
        msg = get_message(block['msgType'])()
        msg.data = float(block['value']) if block['msgType'] == 'std_msgs/msg/Float64' else block['value']
        self.user_publishers[block['topic']][1].publish(msg)

    def topic_condition(self, block):
        """None means missing/stale/invalid data, not a false condition."""
        sample = self.samples.get(block['topic'])
        if not sample or time.monotonic()-sample[1] > 2:
            return None
        value = sample[0]
        for key in block['field'].split('.'):
            if not isinstance(value, dict) or key not in value:
                return None
            value = value[key]
        return condition(value, block['op'], block['value']) if value is not None else None

    def topic_ready(self, block):
        return self.topic_condition(block) is True

    def run_lane(self, blocks, env, stack, lane):
        """Bounded I/O worker. ROS executor remains available for safety/subscriptions."""
        try:
            iterator, index = events(self.program, blocks, env, stack+[lane]), 0
            while True:
                try:
                    block, path, values, phase = next(iterator)
                except StopIteration:
                    break
                index += 1
                if index > 20000:
                    raise RuntimeError('Lane step budget exceeded')
                if self.cancel_workers.is_set():
                    return
                event = {'step': block['id'], 'stack': path, 'env': values, 'phase': phase, 'message': block.get('text', block['type'])}
                try:
                    self.worker_events.put_nowait((lane, event))
                except queue.Full:
                    pass  # Debug sampling must never block cancellation.
                if phase == 'exit':
                    continue
                kind = block['type']
                if kind in ('parallel', 'odom_position'):
                    raise ValueError('Nested parallel and motion are forbidden in worker lanes')
                if kind == 'publish':
                    self.publish_user(block)
                elif kind in ('wait', 'wait_topic', 'if_topic'):
                    started = time.monotonic()
                    limit = block['seconds'] if kind == 'wait' else block['timeout']
                    if not isinstance(limit, (int, float)) or not math.isfinite(limit) or not 0 <= limit <= 3600:
                        raise ValueError('Invalid lane wait')
                    while not self.cancel_workers.is_set():
                        if kind in ('wait_topic', 'if_topic'):
                            decision = self.topic_condition(block)
                            if kind == 'if_topic' and decision is not None:
                                chosen = block['body'] if decision else block['elseBody']
                                iterator = chain(events(self.program, chosen, values, path+['If true' if decision else 'Else']), iterator)
                                break
                            if kind == 'wait_topic' and decision is True:
                                break
                        if time.monotonic()-started >= limit:
                            if kind in ('wait_topic', 'if_topic'):
                                raise TimeoutError('Lane topic timed out: '+block['topic'])
                            break
                        self.cancel_workers.wait(.02)
                elif kind not in ('log', 'call', 'repeat'):
                    raise ValueError('Unknown lane block')
        except Exception:
            self.cancel_workers.set()
            raise

    def close_workers(self):
        self.cancel_workers.set()
        self.workers.shutdown(wait=True, cancel_futures=True)

    def tick(self):
        now = time.monotonic()
        if not self.active:
            if now-self.last_debug > .5:
                self.report()
            return
        try:
            if not self.dry and (not self.safety_ok or now-self.safety_at > .5):
                raise RuntimeError('Safety permit missing/stale; execution stopped')
            if self.current is None:
                self.current = next(self.iterator)
                self.event_count += 1
                if self.event_count > 20000:
                    raise RuntimeError('Execution step budget exceeded')
                self.start_at = now
                self.phase, self.message = self.current[3], self.current[0]['type']
                self.report()
            block, stack, env, phase = self.current
            elapsed, done = now-self.start_at, phase == 'exit'
            kind = block['type']
            if not done:
                if kind in ('log', 'call', 'repeat'):
                    self.message = block.get('text', kind)
                    done = True
                elif kind == 'publish':
                    self.publish_user(block)
                    self.message, done = ('DRY RUN: publish skipped' if self.dry else 'Published '+block['topic']), True
                elif kind == 'parallel':
                    if not isinstance(block.get('branches'), list) or len(block['branches']) != 2:
                        raise ValueError('Parallel requires exactly A and B')
                    for topic_block in self.topic_blocks:
                        self.watch(topic_block['topic'], topic_block.get('msgType'))
                    if self.futures is None:
                        self.lanes = {}
                        self.futures = [self.workers.submit(self.run_lane, branch, dict(env), list(stack), lane)
                                        for branch, lane in zip(block['branches'], ('A', 'B'))]
                    while not self.worker_events.empty():
                        lane, event = self.worker_events.get_nowait()
                        self.lanes[lane] = event
                    for future in self.futures:
                        if future.done():
                            future.result()
                    done = all(f.done() for f in self.futures)
                    if done:
                        self.futures = None
                    self.message = 'A / B finished' if done else 'Running A / B concurrently'
                elif kind == 'wait':
                    if not isinstance(block['seconds'], (int, float)) or not 0 <= block['seconds'] <= 3600:
                        raise ValueError('Invalid wait time')
                    done = elapsed >= block['seconds']
                elif kind in ('wait_topic', 'if_topic'):
                    self.watch(block['topic'], block.get('msgType'))
                    self.message = 'Waiting for fresh topic: '+block['topic']
                    decision = self.topic_condition(block)
                    if decision is not None:
                        if kind == 'if_topic':
                            chosen = block['body'] if decision else block['elseBody']
                            self.iterator = chain(events(self.program, chosen, env, stack+['If true' if decision else 'Else']), self.iterator)
                            self.message, done = 'Condition '+str(decision), True
                        else:
                            done = decision
                    if not done and elapsed > block['timeout']:
                        raise TimeoutError('Topic condition timed out: '+block['topic'])
                elif kind == 'odom_position':
                    if self.dry:
                        self.message, done = 'DRY RUN: motion skipped, not a reached goal', True
                    else:
                        if not self.pose or now-self.pose_at > .5:
                            raise RuntimeError('ODOM missing or stale')
                        if elapsed > block['timeout']:
                            raise TimeoutError('ODOM goal timed out')
                        linear, angular, done = motion(self.pose, block)
                        cmd = Twist()
                        cmd.linear.x, cmd.angular.z = float(linear), float(angular)
                        self.output.publish(cmd)
                        if done:
                            self.stop()
                else:
                    raise ValueError('Unknown block '+kind)
            if done:
                self.report()
                self.current = None
            elif now-self.last_debug > .25:
                self.report()
        except StopIteration:
            self.finish('succeeded', 'Dry run finished' if self.dry else 'Task finished')
        except Exception as error:
            self.finish('failed', str(error))


def main(args=None):
    rclpy.init(args=args)
    node = None
    try:
        node = TaskRunner()
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        if node:
            node.close_workers()
            node.stop()
            node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
