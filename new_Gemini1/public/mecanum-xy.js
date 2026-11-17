'use strict';
// Reference profile: FL, FR, RL, RR. FL interrupts on B to avoid PB0 EXTI0.
const MecanumXY = {
  pins: [['PB12','PB12','PA8','PA0','PA1'],['PB15','PB15','PB6','PA2','PA3'],['PB13','PB13','PB7','PA4','PA5'],['PB14','PB14','PB8','PA6','PA7']],
  odomPins: swapped => swapped ? {x:['PB9','PB5'],y:['PB0','PB1']} : {x:['PB0','PB1'],y:['PB9','PB5']},
  active: design => design?.hardwareTemplate === 'mecanum_xy',
  supported: design => design?.drive === 'diff2' || (MecanumXY.active(design) && design.drive === 'mecanum4'),
  readme: `# Mecanum 4 wheels + passive X/Y position control

Based on codebackupmicronw/mechanum-withencodrxy.
The patched BNO08x 1.2.7 library (including license and local changes) is
exported under lib/Adafruit BNO08x. Do not replace it with the registry
BNO08x library: the reference uses initStage/initStatus and startup fixes. The four parallel drive wheels
use X-pattern mecanum rollers, wheel order FL/FR/RL/RR. Passive tracking wheels
are separate from motor feedback: 29 mm radius, 600 ticks/revolution, x1 decoding.
The 3D template supplies provisional wheel-centre geometry; measure wheelbase
and track before use. Chassis: 660 × 662 mm; drive diameter: 127 mm.
All four drive-wheel speed encoders are disabled in this profile. Motors use
bounded feed-forward PWM; WENC transmits diagnostic wheel ticks/RPM without using them as PID feedback.
The independent passive X/Y tracking encoders remain required for position
control and ODOM. A fresh BNO08x heading is required to separate translation
from rotation and to run position goals; the controller stops position mode
when heading is unavailable.

STM32F103 + PWM/DIR drivers. Motor PWM is 54 kHz. UART1 PA9 TX / PA10 RX.
FL: PWM PA8, DIR PB12. FR: PWM PB6, DIR PB15.
RL: PWM PB7, DIR PB13. RR: PWM PB8, DIR PB14.
Drive encoder pins PA0–PA7 provide WENC tick/RPM diagnostics (x1 decoding). FR/RR motor outputs are
inverted for the physical mecanum layout. Verify motor direction with wheels
raised before testing on the floor.
Default passive X: PB0/PB1 (inverted); passive Y: PB9/PB5.
Hardware Wiring can swap the X/Y input pin pairs without rewiring; check the
generated pin mapping below and adjust each axis Invert if needed.
BNO08x: SCL PB10, SDA PB11, RESET PC13, 3V3, shared GND.

Position controller, Kalman filtering, outlier stop, heading estimator,
feed-forward is retained from the supplied firmware; drive-wheel speed PID is inactive.
Their tuning came from the original robot and must be retuned for mecanum.
Default position speed is 0.35 m/s. Do not assume 500 RPM is achievable loaded.

ROS: /cmd_vel supports x, y and yaw. /controller/position_goal accepts
std_msgs/msg/Float32MultiArray [world_x_m, world_y_m, yaw_rad].
Send a goal once, then publish std_msgs/msg/Empty to /controller/position_keepalive
faster than the configured command timeout while supervising motion.
No automatic keepalive: loss of the commanding client stops the controller.
A new /cmd_vel cancels position mode; zero velocity stops all motors.
/controller/stop (std_msgs/msg/Empty) stops immediately.
/odom uses passive X/Y and heading, with measured body-frame velocities.
/controller/reset_odometry resets pose. Do not run another serial tuner concurrently.

Direct serial commands: T:GOAL:x:y:yaw, T:STATUS (keepalive), T:STOP,
T:POS_SPEED:linear:angular, T:POS_PID_X:kp:ki:kd, T:POS_PID_Y:kp:ki:kd,
T:SELECT:mask, T:PID:kp:ki:kd, T:RPM:rpm, T:START.
Robot Tune reads ODOM X/Y/yaw and real BNO08x GYRO frames. It plots yaw in
degrees and sums travelled distance from successive X/Y positions during the
current connection. WENC sends tick/RPM pairs in FL/FR/RL/RR order, then an
enabled bitmask. Counts reset on board reboot. This diagnostic stream never
enables motor-speed PID or feeds position odometry. No fabricated RPM values
are sent for disabled encoders.
Build using PlatformIO. Verify direction with wheels lifted before floor tests.
`,
  libraryFiles(){return {...MECANUM_XY_LIBRARIES};},
  ini(config) {return `[env:stm32f103]\nplatform = ststm32\nboard = bluepill_f103c8\nframework = arduino\nupload_protocol = serial\nmonitor_speed = ${config.baudRate}\nbuild_flags = -D PIO_FRAMEWORK_CREDENTIALS_NONE -flto\nlib_deps =\n  adafruit/Adafruit BusIO\n  adafruit/Adafruit Unified Sensor\n`;},
  encoderDiagnosticPlan(config,motors){
    const odom=config.odomPinAssignments||MecanumXY.odomPins(config.odomSwapXY===true);
    const used=new Set(['PA9','PA10','PB10','PB11','PC13',...Object.values(odom).flat(),...motors.flatMap(motor=>[motor.in1,motor.pwm])]);
    const exti=pin=>Number(String(pin).match(/^P[A-G](\d+)$/)?.[1]);
    const occupied=new Set(Object.values(odom).map(pair=>exti(pair[0])));
    let mask=0;
    const onB=motors.map((motor,index)=>{
      if(!motor.encA||!motor.encB||motor.encA===motor.encB||used.has(motor.encA)||used.has(motor.encB))return false;
      for(const b of [false,true]){const line=exti(b?motor.encB:motor.encA);if(Number.isInteger(line)&&line>=0&&line<=15&&!occupied.has(line)){occupied.add(line);mask|=1<<index;return b;}}
      return false;
    });return{mask,onB};
  },
  firmware(config, motors) {
    let source=MECANUM_XY_SOURCE;
    const roles=['front_left','front_right','rear_left','rear_right'];
    const motorByRole=new Map(motors.map(motor=>[motor.motorRole,motor]));
    if(motorByRole.size!==4||roles.some(role=>!motorByRole.has(role)))throw new Error('Mecanum XY requires one motor per FL/FR/RL/RR role');
    const orderedMotors=roles.map(role=>motorByRole.get(role));
    const set=(name,value)=>{const re=new RegExp('(constexpr (?:float|uint32_t|bool) '+name+' = )[^;]+;');if(!re.test(source))throw new Error('Missing reference constant '+name);source=source.replace(re,(_,prefix)=>prefix+value+';');};
    const f=value=>Number(value).toFixed(6)+'f';
    set('DRIVE_WHEEL_DIAMETER_M',f(config.wheelDiameterMm/1000));
    set('MECANUM_HALF_LENGTH_M',f(config.wheelBaseMm/2000));set('MECANUM_HALF_WIDTH_M',f(config.wheelTrackMm/2000));
    set('MAX_RPM',f(config.motorMaxRpm));set('COMMAND_TIMEOUT_MS',String(config.commandTimeoutMs));
    set('TICKS_PER_REV',f(orderedMotors.find(motor=>motor.encoderEnabled)?.ppr||600));
    // Drive-wheel diagnostics stay separate from control feedback.
    // The separate PB0/PB1 and PB9/PB5 tracking wheels feed odometry.
    const available=orderedMotors.map(()=>'false');
    const wheelAvailability=/constexpr bool WHEEL_ENCODER_AVAILABLE\[WHEEL_COUNT\] = \{[^}]+\};/;
    if(!wheelAvailability.test(source))throw new Error('Missing wheel encoder availability table');
    source=source.replace(wheelAvailability,`constexpr bool WHEEL_ENCODER_AVAILABLE[WHEEL_COUNT] = {${available.join(', ')}};`);
    let wheelRows=0;
    source=source.replace(/\{(PA\d+, PA\d+, P[AB]\d+, PB\d+, TIM\d, \d), (true|false), (true|false), (true|false) \}/g,(match,pins)=>{
      const fields=pins.split(', ');
      const i=MecanumXY.pins.findIndex(p=>p[2]===fields[2]&&p[0]===fields[3]);
      if(i<0)throw new Error('Unknown Mecanum XY wheel pins: '+pins);
      wheelRows++;
      const motor=motorByRole.get(roles[i]);
      const channel=MecanumXY.pins.findIndex(profile=>profile[2]===motor.pwm);
      if(channel<0)throw new Error('Unknown Mecanum PWM channel: '+motor.pwm);
      const profile=MecanumXY.pins[channel],timer=channel===0?['TIM1','1']:['TIM4',String(channel)];
      return `{${motor.encA||profile[3]}, ${motor.encB||profile[4]}, ${[motor.pwm,motor.in1,...timer].join(', ')}, ${!!motor.motorInvert}, ${motor.invert===-1}, ${i===0} }`;
    });
    if(wheelRows!==4)throw new Error('Expected four Mecanum XY wheel rows, found '+wheelRows);
    // Drive-wheel speed feedback is disabled. Passive X/Y interrupts below
    // remain attached for position odometry.
    let wheelInterrupts=0;
    source=source.replace(/^  attachInterrupt\(digitalPinToInterrupt\(WHEELS\[(FL|FR|RL|RR)\][^\n]+$/gm,(line,role)=>{
      wheelInterrupts++;
      return `  // ${role} motor-speed encoder interrupt disabled`;
    });
    if(wheelInterrupts!==4)throw new Error('Expected four motor encoder interrupts, found '+wheelInterrupts);
    source=source.replace('    pinMode(WHEELS[i].encoder_a, INPUT_PULLUP);\n    pinMode(WHEELS[i].encoder_b, INPUT_PULLUP);','    // Diagnostic encoder setup follows separately from the position controller.');
    const speedMeasureStart=source.indexOf('    state.raw_rpm = (ticks[i] - state.previous_ticks)');
    const speedMeasureEnd=source.indexOf('    if (open_loop_active) {',speedMeasureStart);
    if(speedMeasureStart<0||speedMeasureEnd<0)throw new Error('Missing motor speed measurement block');
    source=source.slice(0,speedMeasureStart)+'    // Diagnostic RPM is separate; use passive X/Y for odometry.\n'+source.slice(speedMeasureEnd);
    const odomPins=config.odomPinAssignments||MecanumXY.odomPins(config.odomSwapXY===true);
    for(const axis of ['x','y']){
      set('ODOM_'+axis.toUpperCase()+'_ENCODER_A',odomPins[axis][0]);
      set('ODOM_'+axis.toUpperCase()+'_ENCODER_B',odomPins[axis][1]);
    }
    const passive=config.robotDesign.encoders.filter(e=>e.enabled!==false&&!e.attachedWheel);
    for(const axis of ['x','y']) {
      const e=passive.find(e=>e.role==='odom_'+axis);
      set('ODOM_'+axis.toUpperCase()+'_ENCODER_INVERTED',String(e.invert===-1));
      set('ODOM_'+axis.toUpperCase()+'_POSITION_'+(axis==='x'?'Y':'X')+'_M',f(axis==='x'?e.y:e.x));
    }
    set('ODOM_TICKS_PER_REV',f(passive[0].ppr));
    source=source.replace('tunerSerial.begin(115200);',`tunerSerial.begin(${config.baudRate});`);
    const patch=(needle,replacement)=>{if(!source.includes(needle))throw new Error('Missing Mecanum protocol anchor: '+needle.slice(0,48));source=source.replace(needle,replacement);};
    patch(`tunerSerial.begin(${config.baudRate});`,`tunerSerial.begin(${config.baudRate});\n  tunerSerial.println("ROSIDE_BOOT");`);
    // A missing BNO08x must not hold RPM/ODOM telemetry behind twenty I2C
    // retry cycles. Five attempts still allow the sensor time to boot.
    patch('int retries = 20;','int retries = 5;');
    patch('const int attempt = 21 - retries;','const int attempt = 6 - retries;');
    patch('char command_buffer[96];','char command_buffer[192];');
    patch('#define tunerSerial Serial1',`#define tunerSerial Serial1
float imu_gyro_dps[3] = {};
uint32_t last_gyro_update_ms = 0;`);
    patch('    if (imu_event.sensorId != SH2_GAME_ROTATION_VECTOR) continue;',`    if (imu_event.sensorId == SH2_GYROSCOPE_CALIBRATED) {
      imu_gyro_dps[0] = imu_event.un.gyroscope.x * (180.0f / PI);
      imu_gyro_dps[1] = imu_event.un.gyroscope.y * (180.0f / PI);
      imu_gyro_dps[2] = imu_event.un.gyroscope.z * (180.0f / PI);
      last_gyro_update_ms = millis();
      continue;
    }
    if (imu_event.sensorId != SH2_GAME_ROTATION_VECTOR) continue;`);
    patch('  // READY requires a real quaternion, not just a successful feature command.',`  if (!bno08x.enableReport(SH2_GYROSCOPE_CALIBRATED, 10000))
    tunerSerial.println("T:WARN:GYRO_REPORT_ENABLE_FAILED");
  // READY requires a real quaternion, not just a successful feature command.`);
    patch('void sendTelemetry() {',`void sendTelemetry() {
  if (imu_ok && last_gyro_update_ms && millis() - last_gyro_update_ms <= 250) {
    tunerSerial.print("GYRO ");
    tunerSerial.print(imu_gyro_dps[0], 3); tunerSerial.print(' ');
    tunerSerial.print(imu_gyro_dps[1], 3); tunerSerial.print(' ');
    tunerSerial.println(imu_gyro_dps[2], 3);
  }`);
    // The legacy target/TEL frames duplicate RPM and cost enough FLASH to
    // overflow a 64 KB BluePill. Keep the common tune protocol as the only
    // periodic wheel telemetry, while retaining position diagnostics.
    const legacyTelemetryStart=source.indexOf('  // Separate frame preserves the existing TEL protocol for older clients.');
    const legacyTelemetryEnd=source.indexOf('\n}',legacyTelemetryStart);
    if(legacyTelemetryStart<0||legacyTelemetryEnd<0)throw new Error('Missing Mecanum legacy telemetry block');
    source=source.slice(0,legacyTelemetryStart)+source.slice(legacyTelemetryEnd);
    // The four drive-wheel encoder pins have no attached ISR and are not
    // represented as measured RPM. Pose telemetry is sent separately.
    // RPM/ODOM already confirm command execution. These legacy acknowledgements
    // are unused by the ROS bridge and free FLASH for the encoder diagnostic.
    for(const name of ['SELECT','RPM','TWIST','OPEN_LOOP'])
      patch(`    tunerSerial.println("T:ACK:${name}");`,'');
    // ODOM already transmits position and heading. The old T:POSE frame is
    // unused by the ROS bridge and Robot Tune and exceeds BluePill FLASH.
    const legacyPoseStart=source.indexOf('void sendPoseTelemetry() {');
    const legacyPoseEnd=source.indexOf('\n}\n\nbool parseFloat3',legacyPoseStart);
    if(legacyPoseStart<0||legacyPoseEnd<0)throw new Error('Missing Mecanum legacy pose frame');
    source=source.slice(0,legacyPoseStart)+'void sendPoseTelemetry() {\n}'+source.slice(legacyPoseEnd+3);
    patch('  tunerSerial.println("T:FW:xy-heading-fallback-20khz-v7");','');
    patch('void processCommand(const char *raw) {',`bool parseControllerValues(const String &text, float *values, uint8_t count) {
  const char *cursor = text.c_str();
  for (uint8_t i = 0; i < count; ++i) {
    char *end;
    values[i] = strtof(cursor, &end);
    if (end == cursor || !isfinite(values[i]) || *end != (i + 1 < count ? ':' : '\\0')) return false;
    cursor = end + (i + 1 < count ? 1 : 0);
  }
  return true;
}

void processCommand(const char *raw) {`);
    // Keep the original T protocol; accept the existing ROS bridge transport too.
    source=source.replace('  const String command(raw);',`  String command(raw);
  if (command == "S") command = "T:STOP";
  else if (command == "Z") command = "T:POSE_RESET";
  else if (command.startsWith("R ")) {
    String values = command.substring(2); values.replace(' ', ':');
    command = "T:WHEEL_RPM:" + values;
  } else if (command.startsWith("P ")) {
    String values = command.substring(2); values.replace(' ', ':');
    command = "T:WHEEL_PID:" + values;
  }
  else if (command.startsWith("V ")) {
    String values = command.substring(2); values.replace(' ', ':');
    float vx, vy, wz;
    if (!parseFloat3(values, vx, vy, wz) || !isfinite(vx) || !isfinite(vy) || !isfinite(wz)) return;
    if (vx == 0.0f && vy == 0.0f && wz == 0.0f) command = "T:STOP";
    else command = "T:TWIST:" + values;
  }`);
    patch('  if (command.startsWith("T:SELECT:")) {',`  if (command.startsWith("T:WHEEL_RPM:")) {
    float values[WHEEL_COUNT];
    if (!parseControllerValues(command.substring(12), values, WHEEL_COUNT)) {
      tunerSerial.println("T:ERR:WHEEL_RPM"); return;
    }
    if (open_loop_active) stopAll();
    twist_active = position_active = false;
    requested_rpm = 0.0f;
    selected_mask = 0x0F;
    for (uint8_t i = 0; i < WHEEL_COUNT; ++i) {
      const float target = constrain(values[i], -MAX_RPM, MAX_RPM);
      if (!pid_override && (!tuner_enabled || fabsf(wheel[i].command_rpm - target) > 0.5f)) {
        const PidGains gains = pidGainsForSpeed(target);
        wheel[i].pid = {gains.kp, gains.ki, gains.kd, 0.0f, 0.0f};
      }
      wheel[i].command_rpm = target;
    }
    tuner_enabled = true;
  } else if (command.startsWith("T:WHEEL_PID:")) {
    float values[WHEEL_COUNT * 3];
    if (!parseControllerValues(command.substring(12), values, WHEEL_COUNT * 3)) {
      tunerSerial.println("T:ERR:WHEEL_PID"); return;
    }
    for (uint8_t i = 0; i < WHEEL_COUNT * 3; ++i) {
      if (values[i] < 0.0f) { tunerSerial.println("T:ERR:WHEEL_PID"); return; }
    }
    for (uint8_t i = 0; i < WHEEL_COUNT; ++i)
      wheel[i].pid = {values[i*3], values[i*3+1], values[i*3+2], 0.0f, 0.0f};
    pid_override = true;
    tunerSerial.print("PID");
    for (uint8_t i = 0; i < WHEEL_COUNT * 3; ++i) {
      tunerSerial.print(' '); tunerSerial.print(values[i], 4);
    }
    tunerSerial.println();
  } else if (command.startsWith("T:SELECT:")) {`);
    patch('    commanded_twist = {vx, vy, wz};',`    const bool new_twist = !twist_active ||
        fabsf(commanded_twist.vx_mps - vx) > 0.001f ||
        fabsf(commanded_twist.vy_mps - vy) > 0.001f ||
        fabsf(commanded_twist.wz_radps - wz) > 0.001f;
    commanded_twist = {vx, vy, wz};`);
    patch('    if (fabsf(wz) <= YAW_COMMAND_DEADBAND_RADPS) yaw_target_latched = false;',
      '    if (new_twist && fabsf(wz) <= YAW_COMMAND_DEADBAND_RADPS) yaw_target_latched = false;');
    patch('  tunerSerial.println("T:READY:wheel_tuner:600");','  tunerSerial.println("ROSIDE_CONTROLLER_READY");');
    const savedGains=config.pid?.motors;
    if(Array.isArray(savedGains)&&savedGains.length===4){
      const triples=savedGains.map((gains,index)=>{
        const values=['kp','ki','kd'].map(key=>Number(gains?.[key]));
        if(values.some(value=>!Number.isFinite(value)||value<0))throw new Error('Invalid saved PID for '+roles[index]);
        return `{${values.map(f).join(', ')}, 0.0f, 0.0f}`;
      });
      patch('  stopAll();\n\n  imu_ok = initialiseImu();',`  stopAll();
  // Restore four separately tuned wheel gains after each firmware restart.
  const Pid saved_wheel_pid[WHEEL_COUNT] = {${triples.join(', ')}};
  for (uint8_t i = 0; i < WHEEL_COUNT; ++i) wheel[i].pid = saved_wheel_pid[i];
  pid_override = true;

  imu_ok = initialiseImu();`);
    }
    source=source.replace('void resetPose() {','bool odom_telemetry_reset = true;\nvoid resetPose() {\n  odom_telemetry_reset = true;');
    source=source.replace(' -\n                         ODOM_X_OFFSET_Y_M * delta_yaw',' +\n                         ODOM_X_OFFSET_Y_M * delta_yaw').replace(' +\n                         ODOM_Y_OFFSET_X_M * delta_yaw',' -\n                         ODOM_Y_OFFSET_X_M * delta_yaw');
    source=source.replace('void sendPoseTelemetry() {',`void sendPoseTelemetry() {
  static float previous_x=0, previous_y=0, previous_yaw=0;
  static uint32_t previous_ms=0;
  const uint32_t now=millis();
  const float dt=previous_ms && !odom_telemetry_reset ? (now-previous_ms)*0.001f : 0;
  odom_telemetry_reset=false;
  const float dx=dt>0 ? (pose_x_m-previous_x)/dt : 0;
  const float dy=dt>0 ? (pose_y_m-previous_y)/dt : 0;
  const float dyaw=atan2f(sinf(imu_yaw_rad-previous_yaw),cosf(imu_yaw_rad-previous_yaw));
  tunerSerial.print("ODOM "); tunerSerial.print(pose_x_m,6); tunerSerial.print(' ');
  tunerSerial.print(pose_y_m,6); tunerSerial.print(' '); tunerSerial.print(imu_yaw_rad,6); tunerSerial.print(' ');
  tunerSerial.print(dx*cosf(imu_yaw_rad)+dy*sinf(imu_yaw_rad),6); tunerSerial.print(' ');
  tunerSerial.print(-dx*sinf(imu_yaw_rad)+dy*cosf(imu_yaw_rad),6); tunerSerial.print(' ');
  tunerSerial.println(dt>0 ? dyaw/dt : 0,6);
  previous_x=pose_x_m; previous_y=pose_y_m; previous_yaw=imu_yaw_rad; previous_ms=now;
`);
    const diagnostic=MecanumXY.encoderDiagnosticPlan(config,orderedMotors);
    const diagnosticPins=orderedMotors.map((motor,i)=>String(diagnostic.onB[i]?motor.encB:motor.encA).match(/^P([A-G])(\d+)$/));
    const diagnosticSource=`
// Read-only wheel encoder diagnostics. They do not enable drive-wheel PID/ODOM.
constexpr uint8_t kWheelDiagnosticMask = ${diagnostic.mask};
constexpr bool kWheelDiagnosticOnB[WHEEL_COUNT] = {${diagnostic.onB.join(', ')}};
constexpr float kWheelDiagnosticRpmPerTickMs[WHEEL_COUNT] = {${orderedMotors.map(motor=>f(60000/Math.max(1,Number(motor.ppr)||600))).join(', ')}};
constexpr uint8_t kWheelDiagnosticLine[WHEEL_COUNT] = {${diagnosticPins.map(pin=>Number(pin?.[2])||0).join(', ')}};
constexpr uint8_t kWheelDiagnosticPort[WHEEL_COUNT] = {${diagnosticPins.map(pin=>(pin?.[1]||'A').charCodeAt(0)-65).join(', ')}};
volatile uint32_t wheel_diagnostic_ticks[WHEEL_COUNT] = {};
volatile uint32_t wheel_diagnostic_edges[WHEEL_COUNT] = {};
void diagnosticWheelEdge(uint8_t index) {
  ++wheel_diagnostic_edges[index];
  const WheelConfig &pins=WHEELS[index];
  const bool phase=digitalRead(kWheelDiagnosticOnB[index]?pins.encoder_a:pins.encoder_b);
  wheel_diagnostic_ticks[index]+=(phase ^ pins.encoder_inverted ^ kWheelDiagnosticOnB[index])?1:-1;
}
${orderedMotors.map((_,i)=>`void diagnosticWheel${i}(){diagnosticWheelEdge(${i});}`).join('\n')}
using WheelDiagnosticIsr = void (*)();
const WheelDiagnosticIsr kWheelDiagnosticIsrs[WHEEL_COUNT] = {diagnosticWheel0,diagnosticWheel1,diagnosticWheel2,diagnosticWheel3};
bool wheelDiagnosticInterruptReady(uint8_t i) {
  const uint8_t line=kWheelDiagnosticLine[i];
  const IRQn_Type irq=line<5?static_cast<IRQn_Type>(EXTI0_IRQn+line):(line<10?EXTI9_5_IRQn:EXTI15_10_IRQn);
  return ((AFIO->EXTICR[line/4] >> ((line%4)*4)) & 15u)==kWheelDiagnosticPort[i]
    && ((EXTI->IMR & EXTI->RTSR) & (1u<<line)) && NVIC_GetEnableIRQ(irq);
}
void attachWheelDiagnosticInterrupt(uint8_t i) {
  const uint32_t pin=kWheelDiagnosticOnB[i]?WHEELS[i].encoder_b:WHEELS[i].encoder_a;
  attachInterrupt(digitalPinToInterrupt(pin),kWheelDiagnosticIsrs[i],RISING);
}
void setupWheelEncoderDiagnostics() {
  // Finish GPIO configuration before attaching any of these interrupts.
  for(uint8_t i=0;i<WHEEL_COUNT;++i)if(kWheelDiagnosticMask & (1u<<i)) {
    pinMode(WHEELS[i].encoder_a,INPUT_PULLUP);pinMode(WHEELS[i].encoder_b,INPUT_PULLUP);
  }
  for(uint8_t i=0;i<WHEEL_COUNT;++i)if(kWheelDiagnosticMask & (1u<<i))attachWheelDiagnosticInterrupt(i);
}
void publishWheelEncoderDiagnostics() {
  static uint32_t previous_ms=0;
  static int32_t previous_ticks[WHEEL_COUNT]={};
  const uint32_t now=millis();
  if (now-previous_ms<100) return;
  int32_t ticks[WHEEL_COUNT];
  noInterrupts(); for(uint8_t i=0;i<WHEEL_COUNT;++i)ticks[i]=static_cast<int32_t>(wheel_diagnostic_ticks[i]); interrupts();
  if (!previous_ms) {previous_ms=now;for(uint8_t i=0;i<WHEEL_COUNT;++i)previous_ticks[i]=ticks[i];return;}
  const float elapsed_ms=now-previous_ms; previous_ms=now;
  tunerSerial.print("WENC");
  for(uint8_t i=0;i<WHEEL_COUNT;++i) {
    const float rpm=static_cast<float>(static_cast<int32_t>(static_cast<uint32_t>(ticks[i])-static_cast<uint32_t>(previous_ticks[i])))*kWheelDiagnosticRpmPerTickMs[i]/elapsed_ms;
    previous_ticks[i]=ticks[i];
    tunerSerial.print(' ');tunerSerial.print(ticks[i]);tunerSerial.print(' ');tunerSerial.print(rpm,1);
  }
  tunerSerial.print(' ');tunerSerial.println(kWheelDiagnosticMask);
  static uint32_t signal_ms=0;
  uint8_t ready=0;
  for(uint8_t i=0;i<WHEEL_COUNT;++i)if(kWheelDiagnosticMask & (1u<<i)) {
    if(wheelDiagnosticInterruptReady(i))ready|=1u<<i;
    else attachWheelDiagnosticInterrupt(i);
  }
  if(now-signal_ms>=500) {
    signal_ms=now;uint32_t signals[WHEEL_COUNT+3]={};signals[2]=ready;
    for(uint8_t i=0;i<WHEEL_COUNT;++i)if(kWheelDiagnosticMask & (1u<<i)) {
      if(digitalRead(WHEELS[i].encoder_a))signals[0]|=1u<<i;
      if(digitalRead(WHEELS[i].encoder_b))signals[1]|=1u<<i;
    }
    noInterrupts();for(uint8_t i=0;i<WHEEL_COUNT;++i)signals[i+3]=wheel_diagnostic_edges[i];interrupts();
    tunerSerial.print("WDIAG");
    for(uint8_t i=0;i<WHEEL_COUNT+3;++i){tunerSerial.print(' ');tunerSerial.print(signals[i]);}tunerSerial.println();
  }
}
`;
    source=source.replace('void setup() {',diagnosticSource+'\nvoid setup() {');
    source=source.replace('  imu_ok = initialiseImu();','  imu_ok = initialiseImu();\n  setupWheelEncoderDiagnostics();');
    source=source.replace('    sendPoseTelemetry();','    sendPoseTelemetry();\n    publishWheelEncoderDiagnostics();');
    return source;
  },
  bridge(source) {
    source=source.replace('from std_msgs.msg import Float32MultiArray','from std_msgs.msg import Empty, Float32MultiArray');
    source=source.replace("self._write('V %.6f 0.0 %.6f' % (msg.linear.x, msg.angular.z))","self._write('V %.6f %.6f %.6f' % (msg.linear.x, msg.linear.y, msg.angular.z))");
    source=source.replace("        self.create_subscription(Float32MultiArray, '/controller/tune_rpm', self._tune_rpm, 20)","        self.create_subscription(Float32MultiArray, '/controller/position_goal', self._position_goal, 10)\n        self.create_subscription(Empty, '/controller/position_keepalive', lambda _: self._write('T:STATUS'), 10)\n        self.create_subscription(Empty, '/controller/stop', lambda _: self._write('T:STOP'), 10)");
    source=source.replace("        self.create_subscription(Float32MultiArray, '/controller/pid_gains', self._pid_topic, 10)\n",'');
    source=source.replace('        self.add_on_set_parameters_callback(self._parameters_changed)\n','');
    source=source.replace("            if self.get_parameter('pid_control_enabled').value:\n                self._send_pid()","            self._serial.write(b'T:STOP\\n')");
    source=source.replace('    def _cmd_vel(self, msg):',`    def _position_goal(self, msg):
        if len(msg.data) != 3 or not all(math.isfinite(v) for v in msg.data):
            self.get_logger().warning('position_goal requires finite [x_m, y_m, yaw_rad]')
            return
        self._write('T:GOAL:%.6f:%.6f:%.6f' % tuple(msg.data))

    def _cmd_vel(self, msg):`);
    source=source.replace('        self._serial = None', '        self._rx_buffer = bytearray()\n        self._serial = None');
    source=source.replace("            self.get_logger().info('Controller serial connected')", "            self._rx_buffer.clear()\n            self.get_logger().info('Controller serial connected')");
    source=source.replace(`            while self._serial.in_waiting:
                line = self._serial.readline().decode('ascii', errors='replace').strip()
                self._handle_line(line)`, `            self._rx_buffer.extend(self._serial.read(self._serial.in_waiting))
            while b'\\n' in self._rx_buffer:
                line, _, rest = self._rx_buffer.partition(b'\\n')
                self._rx_buffer = bytearray(rest)
                self._handle_line(line.decode('ascii', errors='replace').strip())
            if len(self._rx_buffer) > 16384:
                self._rx_buffer.clear()`);
    source=source.replace('        fields = line.split()',`        if line.startswith(('T:ERR:', 'T:SAFE_STOP:', 'T:WARN:')):
            self.get_logger().warning(line)
        fields = line.split()`);
    source=source.replace("            elif len(fields) == 5 and fields[0] == 'RPM':","            elif len(fields) == 9 and fields[0] == 'RPM':");
    return source;
  }
};
