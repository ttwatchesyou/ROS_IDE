'use strict';

const CAPABILITY_PATTERNS = {
  tf: [String.raw`\btf2_ros\b`, String.raw`TransformBroadcaster`, String.raw`StaticTransformBroadcaster`, String.raw`sendTransform\s*\(`, String.raw`robot_state_publisher`],
  odom: [String.raw`nav_msgs(?:\.msg|/msg)?(?:\s+import\s+|::msg::)?Odometry`, String.raw`["']/odom(?:["']|\b)`, String.raw`\bodometry\b`],
  urdf: [String.raw`<robot\b`, String.raw`\brobot_description\b`, String.raw`\bxacro\b`],
  lidar: [String.raw`sensor_msgs(?:\.msg|/msg)?(?:\s+import\s+|::msg::)?LaserScan`, String.raw`["']/scan(?:["']|\b)`, String.raw`\blidar\b`],
  mapping: [String.raw`nav_msgs(?:\.msg|/msg)?(?:\s+import\s+|::msg::)?OccupancyGrid`, String.raw`\bslam_toolbox\b`, String.raw`\bcartographer\b`, String.raw`\bmap_server\b`],
  navigation: [String.raw`\bnav2\w*\b`, String.raw`NavigateToPose`, String.raw`["']/goal_pose(?:["']|\b)`, String.raw`\bamcl\b`],
  control: [String.raw`geometry_msgs(?:\.msg|/msg)?(?:\s+import\s+|::msg::)?Twist`, String.raw`["']/cmd_vel(?:["']|\b)`, String.raw`\bros2_control\b`, String.raw`\bcontroller_manager\b`],
  publisher: [String.raw`\bcreate_publisher\s*(?:<[^>]+>)?\s*\(`],
  subscriber: [String.raw`\bcreate_subscription\s*(?:<[^>]+>)?\s*\(`],
  service: [String.raw`\bcreate_(?:service|client)\s*(?:<[^>]+>)?\s*\(`],
  action: [String.raw`\bAction(?:Server|Client)\b`, String.raw`rclcpp_action::create_(?:server|client)`],
  launch: [String.raw`\bLaunchDescription\s*\(`, String.raw`<launch\b`],
  parameters: [String.raw`\bdeclare_parameter\s*(?:<[^>]+>)?\s*\(`, String.raw`\bget_parameter\s*\(`],
};

function buildProjectScanScript(workspace) {
  const root64 = Buffer.from(String(workspace || ''), 'utf8').toString('base64');
  const defs64 = Buffer.from(JSON.stringify(CAPABILITY_PATTERNS), 'utf8').toString('base64');
  return String.raw`
import base64, json, os, re

root = os.path.expanduser(base64.b64decode('${root64}').decode('utf-8'))
source_root = os.path.join(root, 'src')
definitions = json.loads(base64.b64decode('${defs64}').decode('utf-8'))
skip_dirs = {'build', 'install', 'log', 'node_modules', '__pycache__', '.git', '.idea', '.vscode'}
allowed_ext = {'.py', '.cpp', '.cc', '.cxx', '.c', '.h', '.hh', '.hpp', '.xml', '.urdf', '.xacro', '.yaml', '.yml', '.launch', '.cmake', '.txt', '.json'}
hits = {key: set() for key in definitions}
packages, languages = [], set()
file_count = total_bytes = 0
truncated = False

if os.path.isdir(source_root):
    stop = False
    for dirpath, dirs, files in os.walk(source_root):
        dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith('.')]
        for name in files:
            full_path = os.path.join(dirpath, name)
            rel_path = os.path.relpath(full_path, source_root).replace(os.sep, '/')
            if name == 'package.xml':
                try:
                    package_text = open(full_path, 'r', encoding='utf-8', errors='ignore').read(131072)
                    match = re.search(r'<name>\s*([^<]+?)\s*</name>', package_text)
                    package_name = match.group(1).strip() if match else os.path.basename(dirpath)
                    if package_name and package_name not in packages:
                        packages.append(package_name)
                except OSError:
                    pass
            suffix = os.path.splitext(name)[1].lower()
            if suffix not in allowed_ext and name not in {'CMakeLists.txt', 'package.xml'} and not name.endswith('.launch.py'):
                continue
            try:
                size = os.path.getsize(full_path)
                if size > 524288:
                    continue
                if file_count >= 750 or total_bytes + size > 6291456:
                    truncated = True
                    stop = True
                    break
                text = open(full_path, 'r', encoding='utf-8', errors='ignore').read()
            except OSError:
                continue
            file_count += 1
            total_bytes += size
            if suffix == '.py': languages.add('Python')
            if suffix in {'.cpp', '.cc', '.cxx', '.c', '.h', '.hh', '.hpp'}: languages.add('C/C++')
            if suffix in {'.urdf', '.xacro'}:
                hits['urdf'].add(rel_path)
            if name.endswith('.launch.py') or suffix == '.launch':
                hits['launch'].add(rel_path)
            for capability, patterns in definitions.items():
                if any(re.search(pattern, text, re.IGNORECASE | re.MULTILINE) for pattern in patterns):
                    hits[capability].add(rel_path)
        if stop:
            break

result = {
    'ok': True,
    'workspace': root,
    'sourceRoot': source_root,
    'fileCount': file_count,
    'packageCount': len(packages),
    'packages': sorted(packages)[:30],
    'languages': sorted(languages),
    'truncated': truncated,
    'capabilities': [
        {'id': key, 'detected': bool(hits[key]), 'count': len(hits[key]), 'files': sorted(hits[key])[:4]}
        for key in definitions
    ]
}
print('ROSIDE_PROJECT_SUMMARY=' + json.dumps(result, ensure_ascii=True, separators=(',', ':')))
`;
}

function parseProjectScanOutput(stdout) {
  const marker = 'ROSIDE_PROJECT_SUMMARY=';
  const line = String(stdout || '').split(/\r?\n/).reverse().find(value => value.startsWith(marker));
  if (!line) throw new Error('Project scan returned no result');
  return JSON.parse(line.slice(marker.length));
}

module.exports = { CAPABILITY_PATTERNS, buildProjectScanScript, parseProjectScanOutput };
