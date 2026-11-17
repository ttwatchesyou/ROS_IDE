# Native Blockly execution extension. Generated code is trusted application code,
# NOT a Python sandbox. Custom Python is opt-in and must be reviewed by an adult.

class BlocklyContext:
    def __init__(self, node, lane='Main'):
        self.node, self.lane = node, lane
        self.scope = {'ctx': self}
        self.block_id = None
        self.condition_deadline = None

    def guard(self):
        node = self.node
        if node.cancel_workers.is_set() or not node.active:
            raise RuntimeError('Task cancelled')
        if self.condition_deadline is not None and time.monotonic() >= self.condition_deadline:
            raise TimeoutError('Condition timeout')
        if time.monotonic()-node.start_at > 3600:
            raise RuntimeError('Task exceeded one hour')
        if not node.dry and (not node.safety_ok or time.monotonic()-node.safety_at > .5):
            raise RuntimeError('Fresh safety permit required')
        with node.native_lock:
            node.native_steps += 1
            if node.native_steps > 20000:
                raise RuntimeError('Task step budget exceeded')

    def emit(self, message='', env=None):
        event = {'step': self.block_id, 'stack': [self.lane], 'env': env or {},
                 'phase': 'running', 'message': str(message)[:1000]}
        try:
            self.node.worker_events.put_nowait((self.lane, event))
        except queue.Full:
            pass

    def step(self, block_id, values=None):
        self.guard()
        self.block_id = block_id
        # Never serialize modules, contexts, arbitrary repr(), or unbounded lists.
        env = {str(k)[:60]: v if not isinstance(v, str) else v[:200]
               for k, v in list((values or {}).items())[:80]
               if type(v) in (str, bool, int, float) and not str(k).startswith('_')}
        self.emit(env=env)

    @staticmethod
    def duration(value, limit=600):
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= limit:
            raise ValueError('Invalid duration')
        return value

    def wait(self, seconds):
        until = time.monotonic()+self.duration(seconds, 3600)
        while time.monotonic() < until:
            self.guard()
            self.node.cancel_workers.wait(min(.03, max(0, until-time.monotonic())))

    def read(self, topic, field, timeout=10):
        import re
        if topic not in self.node.native_inputs or not re.fullmatch(r'[A-Za-z_]\w*(\.[A-Za-z_]\w*)*', field):
            raise ValueError('Undeclared topic or invalid field')
        until = time.monotonic()+self.duration(timeout)
        while True:
            self.guard()
            sample = self.node.samples.get(topic)
            if sample and time.monotonic()-sample[1] < 2:
                value = sample[0]
                for key in field.split('.'):
                    value = value.get(key) if isinstance(value, dict) else None
                if value is not None:
                    return value
            if time.monotonic() >= until:
                raise TimeoutError('No fresh data: '+topic+' / '+field)
            self.node.cancel_workers.wait(.03)

    def until(self, test, timeout=10):
        until = time.monotonic()+self.duration(timeout)
        previous = self.condition_deadline
        self.condition_deadline = min(until, previous) if previous is not None else until
        try:
            while True:
                self.guard()
                if test():
                    return
                self.node.cancel_workers.wait(.03)
        finally:
            self.condition_deadline = previous

    def log(self, value):
        self.guard()
        self.emit(value)

    def ask(self, text, value_type):
        raise RuntimeError('Interactive input is only available in the browser preview; use a ROS input topic in a package')

    def publish(self, topic, msg_type, value):
        self.guard()
        if (topic, msg_type) not in self.node.native_outputs:
            raise ValueError('Declare this output Topic and type first')
        self.node.publish_user({'topic': topic, 'msgType': msg_type, 'value': value})
        self.emit(('Dry run: not sent ' if self.node.dry else 'Published ')+topic)

    def move(self, x, y, yaw, speed, timeout):
        if self.lane != 'Main':
            raise RuntimeError('Motion forbidden in parallel workers')
        vals = (x, y, yaw, speed, timeout)
        if any(type(v) not in (float, int) or not math.isfinite(v) for v in vals) or abs(x)>100 or abs(y)>100 or abs(yaw)>180 or not .01<=speed<=.2 or not 1<=timeout<=600:
            raise ValueError('Motion outside safety limits')
        self.guard()
        if self.node.dry:
            self.emit('Dry run: ODOM motion skipped')
            return
        if not self.node.output:
            raise RuntimeError('No commissioned motion output')
        deadline = time.monotonic()+timeout
        block = {'x': x, 'y': y, 'yaw': yaw, 'speed': speed}
        try:
            while True:
                self.guard()
                if time.monotonic() >= deadline:
                    raise TimeoutError('ODOM target timeout')
                if self.node.pose is None or time.monotonic()-self.node.pose_at > .5:
                    raise RuntimeError('Fresh valid ODOM required')
                linear, angular, done = motion(block, self.node.pose)
                if done:
                    return
                msg = Twist()
                msg.linear.x, msg.angular.z = float(linear), float(angular)
                self.node.output.publish(msg)
                self.node.cancel_workers.wait(.03)
        finally:
            self.node.stop()

    def parallel(self, first, second):
        if self.lane != 'Main':
            raise RuntimeError('Nested parallel is forbidden')
        def run(fn, lane):
            try:
                fn(BlocklyContext(self.node, lane))
            except BaseException:
                self.node.cancel_workers.set()
                raise
        futures = [self.node.workers.submit(run, fn, lane) for fn, lane in ((first, 'A'), (second, 'B'))]
        while not all(f.done() for f in futures):
            self.guard()
            self.node.cancel_workers.wait(.02)
        for future in futures:
            future.result()

    def python(self, source):
        self.guard()
        if self.node.dry or not self.node.allow_python:
            raise RuntimeError('Custom Python is not executed in dry_run. Review source, then explicitly enable allow_python with commissioned safety')
        if len(source) > 20000:
            raise ValueError('Custom Python too long')
        # Intentionally full Python, not a sandbox. It can bypass all ctx guards.
        # Never enable for untrusted code. No claim of forced thread cancellation.
        exec(compile(source, '<custom-block>', 'exec'), self.scope, self.scope)
        self.guard()


class BlocklyRunner(TaskRunner):
    def __init__(self):
        super().__init__()
        self.allow_python = self.declare_parameter('allow_python', False).value
        self.native_steps = 0
        self.native_lock = threading.Lock()
        self.native_inputs = {p['topic']: p['msgType'] for p in self.program['native_ports'] if p['direction']=='in'}
        self.native_outputs = {(p['topic'], p['msgType']) for p in self.program['native_ports'] if p['direction']=='out'}
        self.native_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='blockly-main')
        self.native_future = None

    def execute_native(self):
        scope = {'ctx': BlocklyContext(self)}
        exec(compile(GENERATED_BLOCKLY_SOURCE, '<blockly>', 'exec'), scope, scope)

    def tick(self):
        if not self.active:
            return
        try:
            if not self.dry and (not self.safety_ok or time.monotonic()-self.safety_at > .5):
                raise RuntimeError('Fresh safety permit required')
            for topic, kind in self.native_inputs.items():
                self.watch(topic, kind)
            if self.native_future is None:
                self.native_future = self.native_pool.submit(self.execute_native)
            for _ in range(100):
                try:
                    lane, event = self.worker_events.get_nowait()
                except queue.Empty:
                    break
                self.lanes[lane] = event
                self.current = ({'id': event['step']}, event['stack'], event['env'], 'enter')
                self.phase, self.message = event['phase'], event['message']
                self.report()
            if self.native_future.done():
                self.native_future.result()
                self.finish('complete', 'Blockly program complete')
            elif time.monotonic()-self.last_debug > .5:
                self.report()
        except Exception as exc:
            self.finish('failed', str(exc))

    def close_workers(self):
        self.cancel_workers.set()
        # Request zero before joining: trusted custom Python may block a worker.
        # An independent hardware arbiter/E-stop is still required.
        self.stop()
        if hasattr(self, 'native_pool'):
            self.native_pool.shutdown(wait=True, cancel_futures=True)
        super().close_workers()
