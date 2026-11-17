# STM32F103 Wheel PID Tuner

PlatformIO firmware for tuning the four wheel velocity loops before enabling the ROS controller.

## Safety checklist

1. Lift all four wheels off the floor before the first test. Keep motor-driver power off during flashing.
2. Connect USB-to-TTL at 3.3 V logic: adapter TX -> PA10, adapter RX -> PA9, GND -> GND. USART1 is used both by the STM32 system bootloader (BOOT0=1) and by the runtime tuner firmware (BOOT0=0).
3. Disconnect the dashboard tuner and stop `lawengwanla_odom.service` before uploading; only one process may own the serial port.
4. For USB-to-TTL flashing: set BOOT0=1, keep BOOT1=0, press RESET, then run `pio run -t upload --upload-port /dev/serial/by-id/usb-1a86_USB_Serial-if00-port0` if using the same CH340 adapter. Return BOOT0=0 and press RESET before opening the tuning UI.
5. Test one wheel at +30 RPM. Confirm encoder RPM is positive; correct `motor_inverted` or `encoder_inverted` in `include/wheel_config.h` as needed.

The controller starts disabled and turns all motors off if it does not receive a tuner command for one second. A runtime UART connection alone does not enable flashing; BOOT0 must select the STM32 system bootloader first.

## STM32 XY odometry filtering

The STM32 now rejects X/Y encoder increments implying more than 2.5 m/s
or an impossible acceleration jump, then applies one small Kalman position
estimator per axis. Both position
control and `T:POSE` telemetry use the filtered values; this is not a
dashboard-only effect. If an impossible increment occurs during motor motion,
the firmware stops the motors and reports `T:ERR:ODOM_OUTLIER`.

This rejects brief, physically impossible pulse bursts; it cannot guarantee
removal of sustained false counts that resemble real motion. Do not use it as
a substitute for checking the measuring wheels and encoder signals. The new
firmware must be uploaded before source changes affect the robot.

## Drive geometry and position-speed limit

The drive wheels are 5 in (127 mm) in diameter, so
`include/drive_geometry.h` defines a 63.5 mm drive-wheel radius shared by
both kinematics implementations. The passive X/Y odometry wheels remain
separate at 29 mm radius. Position commands are capped at 2.0 m/s, while
the conservative boot default is 0.35 m/s and the wheel command ceiling
is now 500 RPM for supervised speed testing. PWM may reach the existing
255-duty limit when the controller demands it, but 500 RPM is not a promise
of achievable loaded speed. The 5-in radius correction must be uploaded and tested
before interpreting requested speed as calibrated physical speed; the
motor's approximate 500 RPM no-load rating is not a loaded-speed result.
Motor PWM remains fixed at 54 kHz on TIM1/TIM4.

The release build uses link-time optimization and only the required BNO08x
library dependency. Existing tuning reports were retained.
