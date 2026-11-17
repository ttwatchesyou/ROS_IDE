// ══ EDITOR — tabs, save, syntax highlight ══
let currentLang = 'Text';

// ── Tab management ──
async function openFilePath(fp) {
  document.querySelectorAll('.ti.active').forEach(e => e.classList.remove('active'));
  document.getElementById('ft-' + b64k(fp))?.classList.add('active');
  const exist = openTabs.find(t => t.path === fp);
  if (exist) { switchToTab(fp); switchPage('editor'); return; }
  sbMsg('Loading ' + fp.split('/').pop() + '...');
  const res = await API('/api/files/read', { sessionId, path: fp });
  if (!res.ok) { sbMsg('Error: ' + res.error, 3000); return; }
  openTabs.push({ path: fp, content: res.content, modified: false, ...(!isSimWorkspace&&res.revision!==undefined?{revision:res.revision}:{}) });
  renderTabs(); switchToTab(fp); switchPage('editor'); sbMsg('');
}

function switchToTab(fp) {
  activeTab = fp; currentPath = fp;
  const tab = openTabs.find(t => t.path === fp);
  if (!tab) return;
  const fname = fp.split('/').pop();
  const ext = fname.split('.').pop().toLowerCase();
  const lang = extLang(ext);
  document.getElementById('no-file').classList.add('hidden');
  document.getElementById('ed-container').classList.remove('hidden');
  document.getElementById('ed-foot').classList.remove('hidden');
  document.getElementById('btn-save').disabled = false;
  document.getElementById('btn-path').disabled = false;
  document.getElementById('ef-lang').textContent = lang;
  document.getElementById('ef-path').textContent = fp;
  document.getElementById('sb-file').textContent = fname;
  renderCode(tab.content, lang);
  renderTabs();
}

function renderTabs() {
  const bar = document.getElementById('tabbar');
  const acts = bar.querySelector('.tab-acts');
  bar.innerHTML = '';
  bar.appendChild(acts);
  const hint = document.getElementById('no-tab-hint');
  if (openTabs.length === 0) {
    if (hint) { bar.insertBefore(hint, acts); }
    else {
      const h = document.createElement('div');
      h.id = 'no-tab-hint';
      h.style.cssText = 'font-size:11px;color:var(--dim);padding:0 10px';
      h.textContent = 'เปิดไฟล์จาก sidebar';
      bar.insertBefore(h, acts);
    }
    return;
  }
  openTabs.forEach(t => {
    const fname = t.path.split('/').pop();
    const d = document.createElement('div');
    d.className = 'tab' + (t.path === activeTab ? ' active' : '');
    d.innerHTML = `${escH(fname)}${t.modified ? '<span style="color:var(--amb);margin-left:4px">●</span>' : ''}<span class="tab-x">✕</span>`;
    d.querySelector('.tab-x').addEventListener('click', e => closeTab(e, t.path));
    d.onclick = e => { if (!e.target.classList.contains('tab-x')) switchToTab(t.path); };
    bar.insertBefore(d, acts);
  });
}

function closeTab(e, fp) {
  e.stopPropagation();
  const idx = openTabs.findIndex(t => t.path === fp);
  if (idx === -1) return;
  openTabs.splice(idx, 1);
  if (activeTab === fp) {
    if (openTabs.length > 0) switchToTab(openTabs[Math.min(idx, openTabs.length - 1)].path);
    else {
      activeTab = null; currentPath = null;
      document.getElementById('no-file').classList.remove('hidden');
      document.getElementById('ed-container').classList.add('hidden');
      document.getElementById('ed-foot').classList.add('hidden');
      document.getElementById('btn-save').disabled = true;
      document.getElementById('btn-path').disabled = true;
    }
  }
  renderTabs();
}

// ── Save ──
async function saveCurrentFile() {
  if (!currentPath || !sessionId) return;
  const tab = openTabs.find(t => t.path === currentPath);
  if (!tab) return;
  sbMsg('Saving...');
  const ta = document.getElementById('ed-textarea');
  const content = ta ? ta.value : tab.content;
  tab.content = content;
  const revisionTab=openTabs.find(t=>t.path===currentPath);
  const res = await API('/api/files/write', { sessionId, path: currentPath, content, ...(!isSimWorkspace&&revisionTab?.revision!==undefined?{ifRevision:revisionTab.revision}:{}) });
  if(res.ok&&res.revision!==undefined&&revisionTab)revisionTab.revision=res.revision;
  if (res.ok) {
    tab.modified = false; renderTabs();
    document.getElementById('ef-saved').textContent = 'Saved ✓';
    sbMsg('Saved: ' + currentPath.split('/').pop(), 2000);
    setTimeout(() => { document.getElementById('ef-saved').textContent = ''; }, 2500);
    if (sessionId) refreshTree();
  } else {
    sbMsg('Save error: ' + res.error, 3000);
    document.getElementById('ef-saved').textContent = '';
  }
}

// ── Render code (textarea overlay) ──
function renderCode(content, lang) {
  currentLang = lang;
  const lines = content.split('\n');
  document.getElementById('ef-lines').textContent = lines.length + ' lines';
  const ta = document.getElementById('ed-textarea');
  ta.value = content;
  updateHighlight(content, lang);
  updateGutter(lines.length);
  if (!ta._wired) {
    ta._wired = true;
    ta.addEventListener('scroll', syncScroll);
    ta.addEventListener('input', () => {
      const tab = openTabs.find(t => t.path === currentPath);
      if (tab) { tab.modified = true; tab.content = ta.value; }
      renderTabs();
      const ls = ta.value.split('\n');
      document.getElementById('ef-lines').textContent = ls.length + ' lines';
      updateHighlight(ta.value, currentLang);
      updateGutter(ls.length);
      syncScroll();
    });
    ta.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, end = ta.selectionEnd;
        ta.value = ta.value.substring(0, s) + '    ' + ta.value.substring(end);
        ta.selectionStart = ta.selectionEnd = s + 4;
        ta.dispatchEvent(new Event('input'));
      }
    });
  }
}

function syncScroll() {
  const ta = document.getElementById('ed-textarea');
  const hw = document.getElementById('ed-highlight-wrap');
  const gu = document.getElementById('ed-gutter');
  if (hw) { hw.scrollTop = ta.scrollTop; hw.scrollLeft = ta.scrollLeft; }
  if (gu) gu.scrollTop = ta.scrollTop;
}

function updateHighlight(content, lang) {
  const pre = document.getElementById('ed-highlight');
  if (!pre) return;
  const html = content.split('\n').map(line => highlight(line, lang)).join('\n');
  pre.innerHTML = html + '\n';
}

function updateGutter(lineCount) {
  const g = document.getElementById('ed-gutter-lines');
  if (!g) return;
  let html = '';
  for (let i = 1; i <= lineCount; i++) html += `<div style="line-height:21px;min-height:21px">${i}</div>`;
  g.innerHTML = html;
}

function extLang(ext) {
  return { py: 'Python', cpp: 'C++', h: 'C++ Header', hpp: 'C++ Header', xml: 'XML',
    cmake: 'CMake', txt: 'Text', yaml: 'YAML', yml: 'YAML', launch: 'Python (Launch)', sh: 'Shell', md: 'Markdown'
  }[ext] || 'Text';
}

// ── Syntax highlighting tokenizers ──
const T = { KW: 'kw', STR: 'str', NUM: 'num', CM: 'cm', FN: 'fn', INC: 'inc', TAG: 'tag', ATR: 'atr', VAL: 'val', PLAIN: 'plain' };
const SPAN = { [T.KW]: 'kw', [T.STR]: 'str', [T.NUM]: 'num', [T.CM]: 'cm', [T.FN]: 'fn', [T.INC]: 'inc', [T.TAG]: 'tag', [T.ATR]: 'atr', [T.VAL]: 'val' };

function emitTokens(toks) {
  return toks.map(tok => {
    const safe = escH(tok.v || '');
    const cls = SPAN[tok.t];
    return cls ? '<span class="' + cls + '">' + safe + '</span>' : safe;
  }).join('');
}

function highlight(line, lang) {
  if (line === undefined || line === null) return '';
  let toks;
  if (lang === 'Python' || lang === 'Python (Launch)') toks = tokenizePy(line);
  else if (lang === 'C++' || lang === 'C++ Header') toks = tokenizeCpp(line);
  else if (lang === 'XML') toks = tokenizeXml(line);
  else if (lang === 'YAML') toks = tokenizeYaml(line);
  else if (lang === 'Shell') toks = tokenizeShell(line);
  else toks = [{ t: T.PLAIN, v: line }];
  return emitTokens(toks);
}

function tokenizePy(line) {
  const KWS = new Set(['import','from','class','def','return','if','elif','else','for','while',
    'pass','try','except','finally','with','as','in','not','and','or','is',
    'True','False','None','self','super','lambda','yield','raise','del',
    'global','nonlocal','async','await']);
  const toks = []; let i = 0;
  while (i < line.length) {
    if (line[i] === '#') { toks.push({ t: T.CM, v: line.slice(i) }); break; }
    const q3 = line.slice(i, i+3);
    if (q3 === '"""' || q3 === "'''") {
      let j = i+3; while (j < line.length && line.slice(j, j+3) !== q3) j++;
      j = Math.min(j+3, line.length); toks.push({ t: T.STR, v: line.slice(i, j) }); i = j; continue;
    }
    if ('frb'.includes(line[i]) && (line[i+1] === '"' || line[i+1] === "'")) {
      const q = line[i+1]; let j = i+2;
      while (j < line.length && line[j] !== q) { if (line[j] === '\\') j++; j++; }
      j = Math.min(j+1, line.length); toks.push({ t: T.STR, v: line.slice(i, j) }); i = j; continue;
    }
    if (line[i] === '"' || line[i] === "'") {
      const q = line[i]; let j = i+1;
      while (j < line.length && line[j] !== q) { if (line[j] === '\\') j++; j++; }
      j = Math.min(j+1, line.length); toks.push({ t: T.STR, v: line.slice(i, j) }); i = j; continue;
    }
    if (/\d/.test(line[i]) && (i === 0 || !/\w/.test(line[i-1]))) {
      let j = i; while (j < line.length && /[\d._xXa-fA-F]/.test(line[j])) j++;
      toks.push({ t: T.NUM, v: line.slice(i, j) }); i = j; continue;
    }
    if (/[a-zA-Z_]/.test(line[i])) {
      let j = i; while (j < line.length && /\w/.test(line[j])) j++;
      const w = line.slice(i, j); toks.push({ t: KWS.has(w) ? T.KW : T.PLAIN, v: w }); i = j; continue;
    }
    let j = i;
    while (j < line.length && line[j] !== '#' && line[j] !== '"' && line[j] !== "'" && !/[\d\w]/.test(line[j])) j++;
    if (j === i) j = i+1; toks.push({ t: T.PLAIN, v: line.slice(i, j) }); i = j;
  }
  return toks;
}

function tokenizeCpp(line) {
  const KWS = new Set(['return','if','else','for','while','do','switch','case','break','continue',
    'class','struct','public','private','protected','virtual','override','final',
    'new','delete','void','int','float','double','bool','char','short','long',
    'unsigned','signed','auto','const','constexpr','static','inline','explicit',
    'extern','friend','operator','nullptr','true','false','namespace','using',
    'template','typename','try','catch','throw','this','sizeof','typedef','enum','union']);
  const toks = []; let i = 0;
  if (/^\s*#/.test(line)) {
    const m = line.match(/^(\s*#\w+)(.*)/);
    if (m) return [{ t: T.INC, v: m[1] }, { t: T.STR, v: m[2] }];
    return [{ t: T.INC, v: line }];
  }
  while (i < line.length) {
    if (line[i] === '/' && line[i+1] === '/') { toks.push({ t: T.CM, v: line.slice(i) }); break; }
    if (line[i] === '"') {
      let j = i+1; while (j < line.length && line[j] !== '"') { if (line[j] === '\\') j++; j++; }
      j = Math.min(j+1, line.length); toks.push({ t: T.STR, v: line.slice(i, j) }); i = j; continue;
    }
    if (line[i] === "'") {
      let j = i+1; while (j < line.length && line[j] !== "'") { if (line[j] === '\\') j++; j++; }
      j = Math.min(j+1, line.length); toks.push({ t: T.STR, v: line.slice(i, j) }); i = j; continue;
    }
    if (/\d/.test(line[i]) && (i === 0 || !/\w/.test(line[i-1]))) {
      let j = i; while (j < line.length && /[\d._xXa-fA-FuUlL]/.test(line[j])) j++;
      toks.push({ t: T.NUM, v: line.slice(i, j) }); i = j; continue;
    }
    if (/[a-zA-Z_]/.test(line[i])) {
      let j = i; while (j < line.length && /\w/.test(line[j])) j++;
      const w = line.slice(i, j); toks.push({ t: KWS.has(w) ? T.KW : T.PLAIN, v: w }); i = j; continue;
    }
    let j = i;
    while (j < line.length && line[j] !== '/' && line[j] !== '"' && line[j] !== "'" && !/[\d\w]/.test(line[j])) j++;
    if (j === i) j = i+1; toks.push({ t: T.PLAIN, v: line.slice(i, j) }); i = j;
  }
  return toks;
}

function tokenizeXml(line) {
  const toks = []; let i = 0;
  while (i < line.length) {
    if (line[i] === '<') {
      toks.push({ t: T.PLAIN, v: '<' }); i++;
      if (i < line.length && line[i] === '/') { toks.push({ t: T.PLAIN, v: '/' }); i++; }
      let j = i; while (j < line.length && /[\w:-]/.test(line[j])) j++;
      if (j > i) { toks.push({ t: T.TAG, v: line.slice(i, j) }); i = j; }
      while (i < line.length && line[i] !== '>') {
        while (i < line.length && /\s/.test(line[i])) i++;
        if (i >= line.length || line[i] === '>') break;
        if (line[i] === '/' && line[i+1] === '>') { toks.push({ t: T.PLAIN, v: '/>' }); i += 2; break; }
        let k = i; while (k < line.length && /[\w:-]/.test(line[k])) k++;
        if (k > i) { toks.push({ t: T.ATR, v: line.slice(i, k) }); i = k; }
        if (i < line.length && line[i] === '=') {
          toks.push({ t: T.PLAIN, v: '=' }); i++;
          if (i < line.length && line[i] === '"') {
            let end = i+1; while (end < line.length && line[end] !== '"') end++;
            end = Math.min(end+1, line.length);
            toks.push({ t: T.VAL, v: line.slice(i, end) }); i = end;
          }
        } else if (k === i) { i++; }
      }
      if (i < line.length && line[i] === '>') { toks.push({ t: T.PLAIN, v: '>' }); i++; }
    } else {
      let j = i; while (j < line.length && line[j] !== '<') j++;
      if (j > i) toks.push({ t: T.PLAIN, v: line.slice(i, j) }); i = j;
    }
  }
  return toks;
}

function tokenizeYaml(line) {
  const toks = [];
  const m = line.match(/^(\s*)([\w_-]+)(:)(.*)/);
  if (m) {
    if (m[1]) toks.push({ t: T.PLAIN, v: m[1] });
    toks.push({ t: T.ATR, v: m[2] }); toks.push({ t: T.PLAIN, v: m[3] });
    const rest = m[4], ci = rest.indexOf('#');
    if (ci >= 0) { toks.push({ t: T.PLAIN, v: rest.slice(0, ci) }); toks.push({ t: T.CM, v: rest.slice(ci) }); }
    else toks.push({ t: T.PLAIN, v: rest });
    return toks;
  }
  const ci = line.indexOf('#');
  if (ci === 0) return [{ t: T.CM, v: line }];
  if (ci > 0) return [{ t: T.PLAIN, v: line.slice(0, ci) }, { t: T.CM, v: line.slice(ci) }];
  return [{ t: T.PLAIN, v: line }];
}

function tokenizeShell(line) {
  if (/^\s*#/.test(line)) return [{ t: T.CM, v: line }];
  const KWS = new Set(['export','source','echo','cd','ls','mkdir','rm','cp','mv',
    'if','then','fi','else','elif','for','do','done','while','until','function','return','exit']);
  const toks = []; let i = 0;
  while (i < line.length) {
    if (line[i] === '#') { toks.push({ t: T.CM, v: line.slice(i) }); break; }
    if (line[i] === '"' || line[i] === "'") {
      const q = line[i]; let j = i+1;
      while (j < line.length && line[j] !== q) { if (line[j] === '\\') j++; j++; }
      j = Math.min(j+1, line.length); toks.push({ t: T.STR, v: line.slice(i, j) }); i = j; continue;
    }
    if (/[a-zA-Z_]/.test(line[i])) {
      let j = i; while (j < line.length && /[\w-]/.test(line[j])) j++;
      const w = line.slice(i, j); toks.push({ t: KWS.has(w) ? T.KW : T.PLAIN, v: w }); i = j; continue;
    }
    let j = i;
    while (j < line.length && line[j] !== '#' && line[j] !== '"' && line[j] !== "'" && !/\w/.test(line[j])) j++;
    if (j === i) j = i+1; toks.push({ t: T.PLAIN, v: line.slice(i, j) }); i = j;
  }
  return toks;
}
