'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('fresh environment action is beside Add Real Robot and independent of robot cards/sessions',()=>{
const html=fs.readFileSync('public/robots.html','utf8'),js=fs.readFileSync('public/image-tools.js','utf8');
assert.match(html,/เพิ่มหุ่นยนต์จริง<\/button>\s*<a class="btn btn-environment" href="\/image-tools.html"/);
assert.doesNotMatch(html,/rc-image-link|image-tools.html\?robotId/);
assert.doesNotMatch(js,/session\/restore|system-images\/prepare|robotId|ros2ide_session/);
assert.match(js,/api\/environment\/flash/);
});
