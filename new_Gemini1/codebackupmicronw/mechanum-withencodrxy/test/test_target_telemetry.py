"""Protocol compatibility tests; no serial port or robot commands are used."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ros2_ws/src/lawengwanla_backend"))
from lawengwanla_backend import backend_node as backend


class TargetTelemetryTest(unittest.TestCase):
    def setUp(self):
        backend.tuner_state.pop("wheel_targets", None)

    def frame(self, ms):
        backend.parse_tuner_line(f"T:TEL:{ms}:15:0:1:2:3:4:1:2:3:4:0:0:0:0:10:20:30:40")
        return backend.tuner_state["telemetry"]

    def test_legacy_and_matching_frame(self):
        self.assertNotIn("target_rpm_each", self.frame(100))
        backend.parse_tuner_line("T:TARGET:120:100:200:-100:-200")
        self.assertEqual(self.frame(125)["target_rpm_each"], [100, 200, -100, -200])
        self.assertNotIn("target_rpm_each", self.frame(230))
        self.assertNotIn("target_rpm_each", self.frame(0))

    def test_invalid_frame(self):
        backend.parse_tuner_line("T:TARGET:120:nan:2:3:4")
        self.assertNotIn("target_rpm_each", self.frame(125))


if __name__ == "__main__":
    unittest.main()
