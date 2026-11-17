# Robot Task Studio — standard Blockly / project collection (v3)

## Current standalone editor

### Workspace navigation

The standalone page keeps a compact MECHARAYONG top navigation bar with
**Workspace / ROS Tools / Terminal**, shortcuts, account links and local help.
An explicit **← ROS Wizzard** return button stays visible in both the overview
and Blockly views. Menus support touch/click and keyboard navigation; the top
bar stays pinned on scroll and the editor height accounts for it.

Workspace links use `/app?task_studio_page=<allowlisted page>`. The existing
Task Studio entry script consumes this request once after a real session is
ready, invoking the existing Workspace menu handler. Terminal waits for the
existing entitlement check; no permission is bypassed. No route is dispatched
for Simulation, normal `/app` opens, or unknown/command-like values. Opening
menus adds no API requests or robot commands. The build icon navigates to Run
Manager; it does not start a build. The connection dot reports session validation
when opening this page, not continuous live connectivity or a fabricated user count.
Unsaved-work/active-preview warnings remain in place before leaving the page.

Only `/task-studio.html` and its dedicated assets/controllers are changed. The
existing physical-only entry card, main missions, Simulation, robot Agent and
backend execution APIs are not changed by this UI upgrade. No robot program is
installed, started or restarted by editing, saving or exporting a project.

- The first view is **ภาพรวมแอป**, with project cards, a selected application's
  Node/Topic graph and three starter activities. Click a Node's **ต่อบล็อก** button
  to edit it. The header remains compact; the block canvas gets most of the screen.
- **สร้างแอปใหม่**, right-click, tablet long-press and the visible **⋯** menu create,
  rename, duplicate or delete apps. Deletion asks for confirmation and keeps the
  last three deleted apps for recovery. These are local browser drafts, not cloud
  backups. Save explicitly, or export JSON to another device.
- Stock Blockly 12.4.1 is bundled locally with its official blocks and JavaScript /
  Python generators: logic (if/else, comparisons, AND/OR/NOT), loops, math, text,
  lists, variables and procedures including arguments and return values. Standard
  comments, collapse, copy/paste, undo/redo, toolbox, trashcan and zoom are enabled.
  ROS wait/read/publish/ODOM, parallel A/B and editable Python are separate extensions.
  This is stock Blockly plus scoped ROS features, not arbitrary Blockly plugin support.
- **ฟังก์ชัน** creates reusable parameterized blocks. Functions share the same
  workspace as the start flag, as in standard Blockly. Calls may return values.
- **รับข้อมูลจาก Topic** is a value block: connect it to a standard comparison,
  Boolean composition, variable, math or text block. The Topic dropdown includes
  discovered robot topics and app publishers; selecting one infers the message
  type. Offline imported names/types are retained. A standard comparison is the
  hexagonal condition for `if` / `wait until`. Missing/stale data is not false.
- Output Topics also use a dropdown with a **สร้าง Topic ส่งใหม่** choice. Existing
  known topics infer their type; new outputs choose String, Bool or Float64.
  Guarded publishing stays in `/task_studio/user/…`, never actuator/safety topics.
- The graph is derived automatically from all native blocks, including nested
  procedures and declared Python ports. Changing a Topic changes the graph;
  there is no separate manual wire that can disagree with the code. Drag Node
  headers or use arrow keys to arrange. Conflicting types are shown and block
  preview/export. ROS 2 / DDS is a conceptual label, **not a central roscore**.
- **Python ของฉัน** is a named statement block. Select it and click **แก้ Python**
  (or use its block context menu) for a multiline editor and Topic input/output
  rows. Ports are user-declared intent, not automatic analysis of arbitrary Python.
  Python code/variables/functions persist between Python blocks within the same
  execution lane; they do not implicitly read/write Blockly's generated variables.
- **Node** adds a Python executable. **ชื่อ / ไฟล์** changes the package and filename,
  allowing multiple files in a package or independent packages. Export supports
  the full application, selected package, node source + flow, or editable JSON.

## Preview and execution boundaries

**เล่น / ทดลองแอป** regenerates JavaScript from whitelisted Blockly blocks and runs
it in disposable browser Workers. Each Node has a Worker and an isolated preview
bus joins matching app Topics. Imported JavaScript/Python strings are never run in
the browser. Standard procedures are async and propagate their execution-lane
context, so indirect calls cannot acquire Main's motion permission. A/B branches
join before continuing; failure terminates the preview. Pause is at a block
boundary, single-step advances one boundary, and Stop terminates the Workers.
The preview has a 20,000-step / two-minute guard, not a general resource sandbox.
Graph lines briefly animate when a preview message passes (reduced-motion supported).

ODOM blocks in preview only describe the requested target: they do not validate
navigation or move a robot. Explicitly watched, fresh robot samples may be read,
but preview publishing is **only an in-browser bus**. Discovery/monitoring uses the
unchanged authenticated read-only probe. No polling starts just by opening a menu.
The runtime monitor verifies the generated flow hash before highlighting native
blocks and clears stale highlights. Monitor samples are not full-rate telemetry.

**Custom Python stops browser preview at that block** with an explanation; it is
not silently skipped or marked successful. Exported ROS runtime also refuses it
in `dry_run` or unless `allow_python=true` is explicitly enabled after adult review.
Python is full trusted code, **not a sandbox**. It can access files, network and
hardware, bypass `ctx` guards or prevent a worker thread from stopping. Never run
untrusted/imported Python. Production deployments need process isolation and an
independent safety supervisor. `ctx.read/publish/wait/log` are available. Interactive
prompt blocks work only in browser preview; replace them with ROS input topics
before deployment. JS/Python number/string/random behavior may differ.

ROS packages reuse the existing safety-aware TaskRunner with a separate
`BlocklyRunner` extension, leaving the legacy interpreter unchanged. A main worker
executes generated Python while the ROS executor handles subscriptions/safety.
A/B uses two bounded I/O worker threads, no nested parallel or motion in lanes,
including indirect function calls. Avoid racing on shared variables. Threads do
not promise CPU-bound parallel speedup. Launch files default to `dry_run=true`;
this does not publish ROS messages, so ROS input waits need actual input publishers.
Real execution requires the existing commissioned safety permit/arbiter and E-stop.
Motion remains only on `/task_studio/cmd_vel`, never direct `/cmd_vel`. ODOM targets
do not avoid obstacles. Browser Stop is not a robot E-stop.

## Storage, migration and limits

The new collection key is `roside_task_studio_<user>_<robot>_projects_v3`. v1 and
`_application_v2` keys are never overwritten by v3. Legacy functions/parameters and
canonical attached blocks migrate into stock Blockly. Detached v2 draft blocks
also migrate as detached work and prevent execution/export until attached/deleted;
unrecognized legacy draft structure fails migration instead of silently dropping it.
The original app/draft data remains in the migrated project and old storage key.
Import adds a project instead of replacing the current app. Malformed or unknown
blocks are rejected before loading; imported executable source is not trusted.
Saving checks concurrent-tab changes and reports storage failures.
If the v3 collection itself is malformed, the first replacement save preserves
the original raw data in a timestamped recovery key and downloads a recovery JSON.

Limits: 24 saved apps, 16 Nodes/app, 1,500 Blockly blocks/Node, 128 I/O ports/Node,
32 declared ports/Python block, 20,000 characters/Python block, 4 MB collection/import,
one motion-containing Node/app. Native state is saved per Node as `unit.blockly`.
Export includes `project.studio.json`, separate node `.py` files, `.flow.json`,
`.blockly.json`, package metadata/setup and default-dry-run launch files. Node-only
exports require the corresponding ROS package/share environment; choose a package
or full app for buildable scaffolding. Do not remap private user topics to actuators.
The editor can also reopen a standalone exported `.blockly.json` or native
`.flow.json` as a new app, without treating saved generated source as executable input.

Verification: `ROSIDE_TEST_BROWSER=1 node --test --test-reporter=spec` covers the
actual v3 page, stock functions, migration, browser bus, Python gating, graph,
responsive layouts and generated Python syntax; native runtime tests exercise
freshness, deadline/cancellation and safety guards without hardware. The legacy
v2 editor test remains a separate compatibility fixture. No physical motors were
run for these tests. Shared mission/Simulation regression tests remain in the suite.

Vendored library documentation: [Blockly toolbox](https://docs.blockly.com/guides/configure/toolboxes/toolbox/)
and [code generation](https://docs.blockly.com/guides/get-started/code-generation/).
Licenses and asset hashes are in `public/task-blockly-NOTICE.txt`.

---

## Historical v2 behavior (retained compatibility reference)

The sections below describe the previous canonical mini-block editor and its
unchanged runtime. Where they differ, the **v3 sections above are current**.

Standalone special mode for **physical robots only**, at `/task-studio.html`.
The **โหมดพิเศษ** section sits directly below the main mission panel and contains
one **Robot Task Studio** app card. It appears only for a real-robot workspace.
Future apps can be added to the entry script's app list without changing mission
progress. The previous top-bar shortcut has been removed. This is not a wizard
mission and does not replace the existing Flow Editor or Simulation.

## Main and reusable functions

- The standalone page now has **ต่อบล็อก** (real Blockly puzzle editor) and
  **ภาพรวมแอป** (draggable ROS Node/Topic graph). Select a toolbox category, drag
  a block below the start flag, edit its fields, then try **ทดลองเล่น**.
- Starter examples: greeting/repeat, concurrent A/B lanes, and a two-node topic graph.
- **ชุดคำสั่งของฉัน** accepts a friendly Thai title and generates a safe identifier.
  Functions appear as reusable pink puzzle blocks. Advanced numeric parameters
  are inside the function-settings disclosure rather than the primary workspace.
- Create functions, define numeric parameter names, and build their bodies with blocks.
- Drag a function into Main to create a call. Each call has its own argument values.
- Numeric fields accept `$parameter_name`; parameters are local to that call.
- Nested calls and repeat blocks are supported. Recursion, duplicate IDs, missing
  functions, invalid motion limits and invalid argument bindings are rejected.
- Blocks: message, wait, absolute `odom_position`, wait for topic condition, call,
  repeat, parallel A/B, typed user-topic publish, and Topic if/else. Functions accept
  numeric inputs; return values, arbitrary Python and service/action authoring
  are not included yet.
- Blockly supports touch dragging, puzzle snapping, inline fields, copy/paste,
  undo/redo and zoom. Unattached blocks are retained in drafts but block execution
  and package export until attached/deleted. Motion and nested parallel blocks
  are forbidden inside A/B lanes, including when reached through custom calls.
- Drafts are local to this browser/user/robot; save checks for another tab's changes.
  JSON import/export provides backups and transfer. Import does not overwrite robot files.
- New app drafts use the `_application_v2` key, keeping the old v1 storage untouched.
  Import accepts both v1 programs and v2 applications; save all packages/nodes as
  application JSON to transfer or back up your work. Browser storage is not a server backup.

## Topic dropdown and Boolean conditions

- Click **⟳ Topics** above the workspace (or in the ROS toolbox) to discover Topics
  through the existing read-only probe. The condition's dropdown lists discovered
  Topics plus declared application publishers marked **ในแอป**. No discovery or
  subscription is started merely by opening the dropdown.
- Selecting a Topic fills its message type automatically in a read-only label.
  Conflicting message types block preview/export rather than choosing arbitrarily.
  Imported unavailable Topics remain selectable with **ยังไม่พบ**, keeping the
  saved name/type so offline drafts do not silently change to a different Topic.
- **เงื่อนไข Topic** is a hexagonal Boolean output block with field/comparison/value.
  Connect it to **รอจนกว่า** or **ถ้า / มิฉะนั้น**. Missing conditions are retained
  as unfinished drafts but block execution/export.
- **รอจนกว่า** waits for a fresh sample satisfying the condition, up to its timeout.
  **ถ้า / มิฉะนั้น** waits for a usable fresh sample, evaluates once, then executes
  exactly one branch. Missing, stale or absent-field data is not false: it waits
  and fails on timeout, without executing either branch. This behavior also holds
  in Python worker lanes. Each predicate currently tests one scalar Topic field;
  Boolean AND/OR composition is not included.
- Old flat `wait_topic` programs and Blockly drafts reopen as a wait statement
  containing the new predicate; the canonical wait schema and original IDs remain
  compatible. Only the new `if_topic` block needs a freshly exported runtime.

## Application graph and separate files

- **+ Node** creates a Python executable in the selected package; **+ Package**
  creates a separate package with its own Node. Use the selector to edit each.
- Node cards expose output ports for publish blocks and input ports for topic-wait
  blocks, including blocks in functions. Drag from output to input, or tap them
  in order on a tablet. Compatible message types are required. A connection sets
  the receiving block's actual topic name/type. Changing blocks can invalidate a
  connection; validation requires reconnecting it before export.
- Drag card headers (or use arrow keys) to arrange the graph. Discover actual ROS
  topics in the read-only monitor, then add one as an external graph source.
- The center is **ROS Graph / DDS**, a conceptual view of distributed ROS 2
  discovery, not a ROS 1 `roscore` process or central message relay.
- Cutting a wire changes the input to an explicitly disconnected placeholder topic.
- Limits: 16 nodes, 32 external topics, one motion-containing Node per app. Each
  input accepts one explicit wire. Message publishing is limited to String/Bool/
  Float64 on `/task_studio/user/…`, never arbitrary motor/safety command topics.
  Do not remap user topics into actuator or safety inputs.

## Two distinct debug sources

1. **Browser Dry Run:** executes an immutable program snapshot, showing block ID,
   call stack, arguments, and a bounded log. Pause is at the next step boundary;
   an already-running wait completes first. Stop cancels promptly. Single-step
   enters the called function's steps. ODOM blocks are explicitly skipped: this
   is not proof that any physical goal was reached and is not a Simulation run.
   Preview runs only the selected Node, not the whole application. A/B tasks run
   concurrently and join before continuing. Publish writes to an in-browser
   message bus for this preview only; it never sends ROS messages. A failed lane
   cancels its sibling. This JavaScript preview is not an OS-thread benchmark.
2. **ROS monitoring:** opt-in, authenticated, bounded read-only samples on the
   selected robot using the existing Agent exec API. No motor command is sent.
   Discovery, up to 8 watched topics, nested scalar field selection and stale/error
   states are available. Message packages must exist in the robot environment.
   Sampling is not continuous recording; arrays/previews are bounded. Received
   timestamps describe this observer, not guaranteed sensor acquisition time.

Use **ติดตาม Node นี้** to watch `/task_studio/<package>/<file>/debug` from the
generated application/package launch. Legacy direct runner exports still use
`/task_studio/debug`. Debug messages include main step/stack and A/B lane status.
The UI distinguishes dry-run runtime messages from motion-enabled runtime messages.
Only matching SHA-256 program revisions are highlighted. HTTPS/localhost is needed
for browser Web Crypto revision checking; other HTTP origins still display status.
Stale status never implies success or that the robot has stopped. The web Stop
button stops only the browser Dry Run, not a separately launched ROS program.

## ROS package export

Download the whole application, one package, or just a Node source+flow ZIP.
Package/application archives contain `ament_python` metadata, launch files,
one Python executable per Node, editable `flows/<file>.flow.json`, and README. Offline ZIP
creation uses no CDN. Targets the common ROS 2 Humble/Jazzy Python interfaces;
robot-specific deployment and both distro runtime smoke tests remain necessary.
The generated launch defaults to `dry_run=True` and does not create a motion
publisher. Topic-dependent waits still need real input even in dry run.
Dry run also skips ROS publishing. Thus a sender/receiver application does not
communicate in dry run unless the waiting topic has an external publisher.
The Node-only source ZIP is not a standalone installable ROS package.

Application export includes `<app>_bringup/launch/application.launch.py`, launching
each Node in its own process and namespacing debug/stop topics. A/B blocks inside
each Node use two bounded Python worker threads; the ROS executor keeps processing
safety permits and subscriptions. They join before the next main step, use local
function arguments, and cancel on error/stop. This supports concurrent I/O, not a
promise of CPU-parallel Python execution. No nested worker pools or concurrent motion.

Real motion is deliberately **not enabled, deployed, built or started by the page**.
An operator must commission the package with a robot-side command arbiter,
obstacle safety layer, independent velocity watchdog, physical E-stop and fresh
safety permit. The experimental differential-drive controller publishes only to
`/task_studio/cmd_vel`, refuses output remapping, uses a host-local single-owner
lock, caps speed, checks fresh `odom` coordinates and safety permit, and stops on
timeout/cancel/error. It does not itself provide obstacle avoidance or guarantee
stopping after process/OS/hardware failure. Do not directly connect its output to
motors or replace the safety permit with a constant `true` publisher.

ODOM waypoints use absolute odom coordinates; drift, reset and reboot may invalidate
them. Verify origin before a run. This version has no autonomous restart/resume.

## Isolation and verification

The existing special-card entry is unchanged by this UI upgrade. Feature assets
are `task-studio*` and vendored `task-blockly*` files, loaded only by this page.
Blockly 12.4.1 and its Thai messages are local assets; see its LICENSE/NOTICE.
No server route, Agent protocol, existing mission order,
shared Flow generator, firmware or Simulation implementation is modified.
Already-installed Local IDE bundles need a later bundle update to include this UI;
the current cloud page serves it immediately without a backend restart.

Tests: `ROSIDE_TEST_BROWSER=1 node --test test/task-studio*.test.js`.
Coverage includes actual Blockly connections/fields, detached blocks, custom calls,
A/B preview, graph connections, ZIP/Python/XML output, worker overlap/cancellation,
mobile layouts and Sim entry rejection. ROS runtime tests use mocked/pure logic;
real ROS Humble/Jazzy deployment, QoS and hardware commissioning remain unverified.
Robot-facing browser calls use fixtures in tests; no real robot is commanded.
