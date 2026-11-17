"""Sequential NavigateToPose runner, embedded in the real Nav2 stream.
No robot commands are replayed after cancel, failure, or a lost stream.
"""
import math
import time


class NavigationSequence:
    TERMINAL = {'succeeded', 'canceled', 'aborted', 'rejected', 'server_unavailable'}

    def __init__(self, client, goal_factory, make_pose, stop, publish, clock=time.monotonic):
        self.client = client
        self.goal_factory = goal_factory
        self.make_pose = make_pose
        self.stop = stop
        self.publish = publish
        self.clock = clock
        self.generation = 0
        self.run_id = None
        self.points = []
        self.statuses = []
        self.index = 0
        self.phase = 'idle'
        self.handle = None
        self.wait_until = 0.0
        self.seen = []
        self.error = ''

    def snapshot(self):
        return {'runId': self.run_id, 'phase': self.phase, 'index': self.index,
                'total': len(self.points), 'completed': self.statuses.count('succeeded'),
                'steps': list(self.statuses), 'error': self.error,
                'waitRemaining': max(0.0, self.wait_until - self.clock()) if self.phase == 'waiting' else 0.0}

    def emit(self):
        self.publish(self.snapshot())

    def busy(self):
        return self.phase in {'sending', 'active', 'waiting'}

    def blocks_motion(self):
        return self.run_id is not None and self.phase != 'active'

    def start(self, run_id, points):
        if self.busy() or run_id in self.seen:
            return False
        if not isinstance(run_id, str) or not run_id or len(run_id) > 80:
            raise ValueError('Invalid run id')
        if not isinstance(points, list) or not 1 <= len(points) <= 50:
            raise ValueError('Expected 1 to 50 steps')
        clean = []
        for point in points:
            values = [float(point[key]) for key in ('x', 'y', 'yaw')]
            wait = float(point.get('waitSeconds', 0))
            if not all(math.isfinite(value) for value in values + [wait]) or abs(values[0]) > 10000 or abs(values[1]) > 10000 or not 0 <= wait <= 3600:
                raise ValueError('Invalid step')
            clean.append(dict(zip(('x', 'y', 'yaw'), values), waitSeconds=wait))
        self.generation += 1
        self.run_id, self.points = run_id, clean
        self.index, self.handle, self.wait_until, self.error = 0, None, 0.0, ''
        self.statuses = ['pending'] * len(clean)
        self.seen = (self.seen + [run_id])[-100:]
        self._next()
        return True

    def _fail(self, phase, error=''):
        self.phase, self.error = phase, error
        if self.index < len(self.statuses):
            self.statuses[self.index] = phase
        self.stop()
        self.emit()

    def _next(self):
        if self.index >= len(self.points):
            self.phase = 'succeeded'
            self.stop()
            self.emit()
            return
        if not self.client.server_is_ready():
            self._fail('server_unavailable', 'Nav2 action is unavailable')
            return
        point = self.points[self.index]
        message = self.goal_factory()
        message.pose = self.make_pose(point['x'], point['y'], point['yaw'])
        self.phase = 'sending'
        self.statuses[self.index] = 'sending'
        epoch = self.generation
        self.emit()
        try:
            future = self.client.send_goal_async(message)
            future.add_done_callback(lambda response: self._accepted(epoch, response))
        except Exception as error:
            self._fail('aborted', str(error))

    def _accepted(self, epoch, future):
        try:
            handle = future.result()
            if epoch != self.generation:
                if handle.accepted:
                    handle.cancel_goal_async()
                return
            if not handle.accepted:
                self._fail('rejected')
                return
            self.handle = handle
            self.phase = 'active'
            self.statuses[self.index] = 'active'
            self.emit()
            handle.get_result_async().add_done_callback(lambda result: self._result(epoch, result))
        except Exception as error:
            if epoch == self.generation:
                self._fail('aborted', str(error))

    def _result(self, epoch, future):
        if epoch != self.generation:
            return
        self.handle = None
        try:
            status = future.result().status
            if status != 4:  # action_msgs/GoalStatus.STATUS_SUCCEEDED
                self._fail('canceled' if status == 5 else 'aborted')
                return
            self.statuses[self.index] = 'succeeded'
            self.wait_until = self.clock() + self.points[self.index]['waitSeconds']
            self.index += 1
            self.phase = 'waiting'
            self.stop()
            self.emit()
        except Exception as error:
            self._fail('aborted', str(error))

    def tick(self):
        if self.phase == 'waiting':
            if self.clock() >= self.wait_until:
                self._next()
            else:
                self.emit()

    def cancel(self):
        if not self.busy():
            return
        self.generation += 1
        handle, self.handle = self.handle, None
        if handle is not None:
            try:
                handle.cancel_goal_async()
            except Exception:
                pass
        self._fail('canceled')

    def clear(self):
        self.cancel()
        self.run_id, self.phase = None, 'idle'
        self.emit()
