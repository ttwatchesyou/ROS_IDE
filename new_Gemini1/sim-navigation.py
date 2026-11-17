"""Bounded, cached grid planning for MapSim; no ROS or third-party dependencies."""
import math
import time
import heapq


def _nav_edt(values):
    """Exact squared Euclidean distance transform of a one-dimensional row."""
    n = len(values)
    sites = [0] * n
    bounds = [float('-inf')] + [float('inf')] * n
    k = 0
    for q in range(1, n):
        p = sites[k]
        cross = ((values[q] + q*q) - (values[p] + p*p)) / (2*(q-p))
        while cross <= bounds[k]:
            k -= 1
            p = sites[k]
            cross = ((values[q] + q*q) - (values[p] + p*p)) / (2*(q-p))
        k += 1
        sites[k], bounds[k], bounds[k+1] = q, cross, float('inf')
    result = [0] * n
    k = 0
    for q in range(n):
        while bounds[k+1] < q:
            k += 1
        result[q] = (q-sites[k])**2 + values[sites[k]]
    return result


class NavigationGrid:
    def __init__(self, data, width, height, resolution, origin, walls=(), allow_unknown=False):
        if not (0 < width <= 1000 and 0 < height <= 1000 and width*height <= 400000
                and len(data) == width*height and math.isfinite(resolution) and resolution > 0
                and all(math.isfinite(v) for v in origin)):
            raise ValueError('invalid or oversized navigation grid')
        self.width, self.height, self.resolution = width, height, resolution
        self.ox, self.oy = origin
        occupied = bytearray(v >= 65 or (v < 0 and not allow_unknown) for v in data)
        # Saved SLAM maps can miss a real wall. Include known simulation geometry.
        for wall in walls:
            x1, y1, x2, y2 = wall[:4]
            steps = max(1, math.ceil(math.hypot(x2-x1, y2-y1) / (resolution*.5)))
            for i in range(steps+1):
                x, y = self.cell(x1+(x2-x1)*i/steps, y1+(y2-y1)*i/steps)
                if 0 <= x < width and 0 <= y < height:
                    occupied[y*width+x] = 1
        for x in range(width):
            occupied[x] = occupied[(height-1)*width+x] = 1
        for y in range(height):
            occupied[y*width] = occupied[y*width+width-1] = 1
        squared = []
        for y in range(height):
            squared.extend(_nav_edt([0 if v else 1e12 for v in occupied[y*width:(y+1)*width]]))
        self.distance = [0.0] * len(data)
        for x in range(width):
            column = _nav_edt(squared[x::width])
            for y, value in enumerate(column):
                # Account for both occupied-cell and robot-cell area, not just centres.
                self.distance[y*width+x] = max(0, math.sqrt(value)*resolution - math.sqrt(2)*resolution)
        self.signature = None
        self.builds = 0
        self.expansions = 0
        self.error = ''

    def configure(self, radius=.24, clearance=.08, inflation=.55, scaling=3):
        hard = max(.24, radius) + max(.02, clearance)
        signature = (hard, max(hard, inflation), scaling)
        if self.signature == signature:
            return
        self.signature = signature
        self.blocked = bytearray(d <= hard for d in self.distance)
        self.cost = [2*math.exp(-scaling*max(0, d-hard)) if d < signature[1] else 0 for d in self.distance]
        self.builds += 1

    def cell(self, x, y):
        return math.floor((x-self.ox)/self.resolution), math.floor((y-self.oy)/self.resolution)

    def free(self, cell):
        x, y = cell
        return 0 <= x < self.width and 0 <= y < self.height and not self.blocked[y*self.width+x]

    def line_free(self, start, end):
        # Supercover traversal includes BOTH cells at corner crossings.
        x, y = self.cell(*start)
        ex, ey = self.cell(*end)
        if not self.free((x, y)) or not self.free((ex, ey)):
            return False
        dx, dy = end[0]-start[0], end[1]-start[1]
        sx, sy = (1 if dx > 0 else -1), (1 if dy > 0 else -1)
        delta_x = self.resolution/abs(dx) if dx else float('inf')
        delta_y = self.resolution/abs(dy) if dy else float('inf')
        next_x = (self.ox+(x+(1 if dx > 0 else 0))*self.resolution-start[0])/dx if dx else float('inf')
        next_y = (self.oy+(y+(1 if dy > 0 else 0))*self.resolution-start[1])/dy if dy else float('inf')
        for _ in range(self.width+self.height+2):
            if (x, y) == (ex, ey):
                return True
            if abs(next_x-next_y) < 1e-10:
                if not self.free((x+sx, y)) or not self.free((x, y+sy)):
                    return False
                x, y = x+sx, y+sy
                next_x, next_y = next_x+delta_x, next_y+delta_y
            elif next_x < next_y:
                x, next_x = x+sx, next_x+delta_x
            else:
                y, next_y = y+sy, next_y+delta_y
            if not self.free((x, y)):
                return False
        return False

    def plan(self, start_point, goal_point, budget_ms=60, max_expansions=18000):
        self.error, self.expansions = '', 0
        start, goal = self.cell(*start_point), self.cell(*goal_point)
        if not self.free(start) or not self.free(goal):
            self.error = 'จุดเริ่มหรือจุดหมายใกล้วัตถุเกินขนาดหุ่น + ระยะปลอดภัย (รวมความละเอียด Map)'
            return []
        deadline = time.thread_time() + max(.001, min(.15, budget_ms/1000))
        queue, costs, came, closed = [(0, 0, start)], {start: 0}, {}, set()
        directions = ((-1,0,1),(1,0,1),(0,-1,1),(0,1,1),(-1,-1,math.sqrt(2)),(1,-1,math.sqrt(2)),(-1,1,math.sqrt(2)),(1,1,math.sqrt(2)))
        while queue:
            _, cost, current = heapq.heappop(queue)
            if current in closed or cost != costs[current]:
                continue
            if current == goal:
                cells = [current]
                while cells[-1] != start:
                    cells.append(came[cells[-1]])
                points = [(self.ox+(x+.5)*self.resolution, self.oy+(y+.5)*self.resolution) for x,y in reversed(cells)]
                # Do not snap a blocked goal to a free cell then append the unsafe goal.
                points = [start_point] + points + [goal_point]
                return points
            closed.add(current)
            self.expansions += 1
            if self.expansions >= max_expansions or (self.expansions % 64 == 0 and time.thread_time() >= deadline):
                self.error = 'เกินงบคำนวณเส้นทาง กรุณาเลือกเป้าใกล้ขึ้นหรือเพิ่มงบ CPU'
                return []
            x, y = current
            for dx, dy, step in directions:
                cell = (x+dx, y+dy)
                if cell in closed or not self.free(cell):
                    continue
                if dx and dy and (not self.free((x+dx,y)) or not self.free((x,y+dy))):
                    continue
                candidate = cost + step*(1+self.cost[cell[1]*self.width+cell[0]])
                if candidate >= costs.get(cell, float('inf')):
                    continue
                costs[cell], came[cell] = candidate, current
                heuristic = math.hypot(goal[0]-cell[0], goal[1]-cell[1])
                heapq.heappush(queue, (candidate+heuristic, candidate, cell))
        self.error = 'ไม่พบทางที่มีระยะปลอดภัยเพียงพอ'
        return []
