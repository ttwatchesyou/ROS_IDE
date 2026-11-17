"""Dependency-free spatial index embedded into generated simulation nodes."""
import math


class WallIndex:
    def __init__(self, walls):
        self.root = self._build(list(walls)) if walls else None

    def _build(self, walls):
        bounds = (min(min(w[0], w[2]) for w in walls),
                  min(min(w[1], w[3]) for w in walls),
                  max(max(w[0], w[2]) for w in walls),
                  max(max(w[1], w[3]) for w in walls))
        if len(walls) <= 8:
            return bounds, None, None, walls
        axis = 0 if bounds[2] - bounds[0] >= bounds[3] - bounds[1] else 1
        walls.sort(key=lambda w: w[axis] + w[axis + 2])
        middle = len(walls) // 2
        return bounds, self._build(walls[:middle]), self._build(walls[middle:]), None

    @staticmethod
    def _entry(bounds, ox, oy, dx, dy, limit):
        near, far = 0.0, limit
        for origin, direction, low, high in ((ox, dx, bounds[0], bounds[2]), (oy, dy, bounds[1], bounds[3])):
            if abs(direction) < 1e-12:
                if origin < low - 1e-9 or origin > high + 1e-9:
                    return None
            else:
                a, b = (low - origin) / direction, (high - origin) / direction
                near, far = max(near, min(a, b)), min(far, max(a, b))
                if near > far + 1e-9:
                    return None
        return near

    def ray(self, ox, oy, angle, limit):
        dx, dy, best = math.cos(angle), math.sin(angle), limit
        stack = [self.root] if self.root else []
        while stack:
            node = stack.pop()
            if self._entry(node[0], ox, oy, dx, dy, best) is None:
                continue
            if node[3] is not None:
                for x1, y1, x2, y2 in node[3]:
                    sx, sy = x2 - x1, y2 - y1
                    den = dx * sy - dy * sx
                    if abs(den) < 1e-9:
                        continue
                    t = ((x1 - ox) * sy - (y1 - oy) * sx) / den
                    u = ((x1 - ox) * dy - (y1 - oy) * dx) / den
                    if 0 < t < best and 0 <= u <= 1:
                        best = t
            else:
                children = []
                for child in (node[1], node[2]):
                    entry = self._entry(child[0], ox, oy, dx, dy, best)
                    if entry is not None:
                        children.append((entry, child))
                # Push the farther child first, so nearest hits prune more work.
                children.sort(key=lambda item: item[0], reverse=True)
                stack.extend(child for _, child in children)
        return best
