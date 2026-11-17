# TF / ODOM — robot model visual consistency

Updated: 2026-09-16. Box-axis and accessory appearance fixes apply to **Sim and
real robot** assembly workspaces. Advanced custom-mesh export remains real-only.

## Assembly arrows and view controls

- Translation/scale handles now stay on the positive local axes of the selected
  component, including when viewed from behind. Their mouse hit targets use the
  same direction. They do not flip toward the camera. Screen-left/right naturally
  depends on the viewing angle; the actual TF direction does not change.
- ROS X is red, Y green and Z blue consistently in the gizmo and property labels.
  This is an instance-local adapter for the pinned Three.js r128 control; no
  shared control prototype or other editor is modified.
- Left drag / one finger orbits. Right/middle drag or Shift+left drag pans in
  screen directions, in every camera angle and both projections. Wheel zoom is
  proportional; two fingers pan/pinch. A click selects, a stationary right-click
  or long press opens the existing menu. Navigation cannot simultaneously drag
  a component. Pointer capture/blur/cancel release gestures cleanly.
- **F / โฟกัสชิ้นส่วน** frames the selected object. **ดูทั้งหุ่น** fits the model
  while retaining the view angle. **Home / คืนมุมมอง** fits the whole robot in
  the default 3D view. These controls are in the existing **มุมมอง** menu.
- Top/bottom plans put robot-forward (+X) upward. Preset transitions take the
  shortest turn, and manual navigation cancels a transition immediately.
  View-only operations do not change model/TF data or send runtime commands.

`node --test test/robot-editor-view.test.js` tests screen-relative camera math,
axis/picker direction from all hemispheres, local rotations, presets and isolated
controls. The model browser test also uses actual mouse/touch events to exercise
pan, orbit, positive-axis dragging, pinch, context menus, focus and reset.

## What changed

- Ordinary boxes and accessory boxes now use ROS X = length/forward,
  Y = width/left, Z = height/up in both the TF canvas and saved URDF.
  Previously, the canvas swapped X and Y, while URDF did not. Existing numbers
  and user-entered RPY are retained; old designs now display in the direction
  their existing URDF described. No automatic 90-degree rotation is added.
- Scale handles use the same axes. Front/back camera presets are corrected.
- Eight accessory presets have parametric mechanical details: a rounded battery
  case, lid, carrying handle, polarity marks and terminals; controller ports and
  cooling fins, mounting plate slots, telescopic sensor mast, motor shaft and vents,
  bumper strip/reflectors, anti-slip payload tray and antenna connector.
  These are illustrative models, not manufacturer-certified CAD/dimensions.
- The accessory palette uses small static thumbnails rendered from these models.
  They are cached for the page, with no animation or external image requests.
  If WebGL thumbnails are unavailable, labelled icon buttons remain usable.
- Accessory identity is stored in `params.accessory` so renaming/copying does not
  remove details. Exact old palette names (for example `battery_1`) are recognised;
  arbitrary boxes are not reclassified. `accessoryRevision: 2` updates old factory
  colours once; user-customized colours, dimensions, positions and RPY are retained.
  Colours and mechanical dimensions remain editable.
- Real custom objects carry a `customDef` snapshot inside `tf_model.json` and the
  browser model. Reopening on a browser without the original custom library keeps
  the saved design. Existing library entries are not overwritten or deleted.
- Composite primitives, imported CAD and bevelled boxes export the actual displayed
  geometry, per-material colours and local transforms as ASCII STL files. This
  also avoids exporting a non-standard `<cone>` element or replacing CAD with a box.
  Non-uniform custom scaling is stored as ROS `params.visualScale`.
- The legacy standard-wheel frame offset is retained. Children mounted to a wheel
  receive the compensating origin in real mode so their world pose matches the canvas.
  URDF, generated TF Python and static-transform commands use that same correction.

## Saving and displaying

Use **บันทึกทั้งหมด** in TF to write the existing `sim_robot_tf` package (the name
is retained for compatibility even in real mode). In real mode, where needed, it includes
`meshes/tf_<content-hash>.stl`, and `setup.py` installs these files. The saved URDF
references `package://sim_robot_tf/meshes/...`. The existing TF/ODOM save routes
and main-mission flow are retained. No new endpoint, automatic build, launch,
motor command, or service restart is introduced.

Sim accessories use only standard URDF boxes and cylinders, generated from the
same dimensions/poses as their viewport details. They do not require STL assets
or a new loader. Sim's existing wheel-ODOM Python embeds the generated URDF;
only that visual data changes, not its control/kinematics code.

In real mode, standalone URDF download includes a ZIP package when meshes are required, rather
than a URDF file with missing assets. Web RViz reads only these generated mesh
filenames through the existing authenticated, session-scoped file-read API. Failed
loads are reported, not silently replaced with an unrelated box. Reads are coalesced
and pending results are discarded after geometry disposal or session changes.

After refreshing the UI, review the TF canvas and save again to regenerate an old
package. A ROS process already running with the old installed URDF will not change
until the user builds/reloads it through the existing workflow.

## Boundaries

- The September 16 Sim change is limited to box visual axes, matching scale handles,
  camera front/back presets, accessory style/metadata and primitive visual URDF.
  No user-entered TF rotation is automatically changed to compensate for the old
  swapped axes. Sim's TF commands, TF Python, ODOM logic, control, SLAM and world
  files are unchanged; no service or running simulation is restarted.
- Advanced custom CAD snapshots, STL/ZIP export and generated-mesh file loading
  remain guarded by real mode; they were not enabled for Sim.
- Mesh export currently preserves material colours, not bitmap UV textures.
  Textured custom geometry produces an explicit save error before any package
  write; use plain material colours instead. It is not silently downgraded.
- Renderer lighting and material response can differ between TF, web RViz and
  native RViz. Geometry/poses/material colours are exported; lighting is not.
- Collision geometry is still an approximation for built-in hardware. Slots on
  mounting plates are decorative. Existing rounded wheel rollers retain their
  segmented-cylinder URDF approximation. These visuals do not certify collision
  clearance, mass properties or real hardware safety.

## Verification

`node --test test/robot-model-parity.test.js` checks all built-in component types,
all presets, mixed RPY, child-of-wheel transforms, dimensions, save/reopen,
custom/composite/CAD meshes, colours, missing-library restoration and both modes'
box/accessory geometry. Frozen pre-change hashes verify Sim TF/ODOM logic, with
only the embedded visual URDF allowed to change. Sim's legacy 1 mm TF-origin
serialization precision is retained.
It compares the canvas's ROS bounds with independently reconstructed URDF geometry.

`ROSIDE_TEST_BROWSER=1 node --test test/robot-model-browser.test.js` renders the
actual Sim and real TF pages, accessory thumbnails and saved URDF with the existing web RViz loader. API responses are
mocked: this test never contacts a real robot or runs ROS. `three@0.128.0` is a
development-only test dependency matching the existing browser's Three.js version.

ROS conventions/reference: [REP 103](https://github.com/ros-infrastructure/rep/blob/master/rep-0103.rst),
[ROS 2 URDF tutorial](https://github.com/ros/urdf_tutorial/blob/ros2/urdf/07-physics.urdf).
