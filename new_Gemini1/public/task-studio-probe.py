"""Bounded, read-only ROS topic sample. Executed only on the selected physical robot."""
import base64
import json
import math
import os
import time
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
from rosidl_runtime_py.utilities import get_message
from rosidl_runtime_py.convert import message_to_ordereddict

topics = json.loads(base64.b64decode('__TOPICS_BASE64__'))[:8]
rclpy.init()
node = Node('task_studio_probe_'+str(os.getpid()), enable_rosout=False, start_parameter_services=False)
samples, subscriptions = {}, []
try:
    start = time.monotonic()
    while time.monotonic()-start < .4:
        rclpy.spin_once(node, timeout_sec=.05)
    graph = dict(node.get_topic_names_and_types())
    def clean(value, depth=0):
        if depth > 12:
            return '<depth limit>'
        if isinstance(value, dict):
            return {k: clean(v, depth+1) for k, v in list(value.items())[:100]}
        if isinstance(value, (list, tuple)):
            return [clean(v, depth+1) for v in value[:128]]
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value
    for topic in topics:
        types = graph.get(topic, [])
        samples[topic] = {'state': 'waiting' if types else 'missing'}
        if len(types) != 1:
            continue
        try:
            publishers = node.get_publishers_info_by_topic(topic)
            transient = bool(publishers) and all(p.qos_profile.durability == DurabilityPolicy.TRANSIENT_LOCAL for p in publishers)
            qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT,
                             durability=DurabilityPolicy.TRANSIENT_LOCAL if transient else DurabilityPolicy.VOLATILE)
            def receive(msg, name=topic):
                data = clean(message_to_ordereddict(msg))
                encoded = json.dumps(data, allow_nan=False)
                if len(encoded) > 32768:
                    samples[name] = {'state': 'oversize', 'error': 'Message too large to preview'}
                else:
                    samples[name] = {'state': 'received', 'data': data, 'at': time.monotonic()}
            subscriptions.append(node.create_subscription(get_message(types[0]), topic, receive, qos))
        except Exception as error:
            samples[topic] = {'state': 'error', 'error': str(error)[:200]}
    start = time.monotonic()
    while time.monotonic()-start < .8:
        rclpy.spin_once(node, timeout_sec=.05)
    for sample in samples.values():
        if 'at' in sample:
            sample['ageMs'] = round((time.monotonic()-sample.pop('at'))*1000)
    print('TASK_STUDIO='+json.dumps({'topics': [{'name': k, 'types': v} for k, v in sorted(graph.items())[:500]], 'samples': samples}, allow_nan=False))
finally:
    node.destroy_node()
    rclpy.shutdown()
