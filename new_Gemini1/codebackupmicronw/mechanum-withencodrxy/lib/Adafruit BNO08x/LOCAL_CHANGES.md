# Local BNO08x startup fixes

Based on Adafruit BNO08x 1.2.7. Original license retained in license.txt.

- Restore I2C address detection; the past begin(false) workaround hid ACK errors.
- Expose initStage/initStatus to the application's Serial1 diagnostics.
- Close SH-2 after a Product ID failure. Otherwise the next sh2_open loses the
  reference to an occupied static SHTP slot. This is a session resource issue,
  not evidence of heap exhaustion or a microcontroller reset.
- Wait 300 ms after releasing hardware reset before sending software reset.
  This conservative delay needs hardware verification; it does not establish
  the original fault's cause.

The application retains 20 attempts at 0x4A and 0x4B, with hardware reset and
one-second delay after each failed pair. It ends the STM32 Wire peripheral
before each library begin and requires a game rotation vector before READY.
SDA=PB11, SCL=PB10, sensor NRST=PC13 are existing wiring assumptions.

For I2C, BNO086 PS1/PS0 must both be low at reset; BOOTN must be high to run
application firmware. These are sensor pins, not the STM32 BOOT0 jumper.
Refer to the breakout schematic before changing its jumpers.

Reference: https://www.ceva-ip.com/wp-content/uploads/BNO080_085-Datasheet.pdf
