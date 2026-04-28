// build.mjs — Statische Survey-Seite bauen mit Diff-Hervorhebung
// Liest Umfrage/Szenario A/* und Umfrage/Szenario B/*, rendert mit Shiki + AL-Grammar,
// markiert hinzugefügte/entfernte Zeilen anhand der zugehörigen Git-Patches.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';
import plist from 'plist';
import { createHighlighter } from 'shiki';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UMFRAGE_DIR = path.join(ROOT, 'Umfrage');
const OUTPUTS_DIR = path.join(ROOT, 'framework-tests', 'outputs');
const OUT_DIR = path.join(__dirname, 'docs');
const ASSETS_SRC = path.join(__dirname, 'assets');

const SCENARIOS = [
  { label: 'Szenario A', dir: 'Szenario A', slug: 'szenario-a', outputsSub: 'a-hard' },
  { label: 'Szenario B', dir: 'Szenario B', slug: 'szenario-b', outputsSub: 'b-hard' },
];

const FRAMEWORKS = ['claude', 'codex', 'copilot', 'cursor', 'gemini'];

// ---------- Mapping + Grammar ----------

async function loadMapping() {
  const raw = await fs.readFile(path.join(__dirname, 'mapping.json'), 'utf8');
  const json = JSON.parse(raw);
  return {
    'szenario-a': json['szenario-a'],
    'szenario-b': json['szenario-b'],
  };
}

async function loadAlGrammar() {
  const candidates = await fg('ms-dynamics-smb.al-*/syntaxes/alsyntax.tmlanguage', {
    cwd: path.join(process.env.HOME || '', '.vscode/extensions'),
    absolute: true,
  });
  if (candidates.length === 0) {
    throw new Error('AL-Grammar nicht gefunden. Bitte AL-Extension in VS Code installieren.');
  }
  candidates.sort().reverse();
  const grammarPath = candidates[0];
  const xml = await fs.readFile(grammarPath, 'utf8');
  const parsed = plist.parse(xml);
  return { grammar: parsed, source: grammarPath };
}

function languageForFile(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.al')) return 'al';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.md')) return 'markdown';
  if (lower.endsWith('.xml')) return 'xml';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  return 'text';
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- Unified-Diff-Parser ----------

// Liefert Map<relPath, { isNew, isDeleted, addedLines:Set<int>, deletionsByNewLine:Map<int, string[]>, insertions, deletions }>
function parseUnifiedDiff(patch) {
  const result = new Map();
  const lines = patch.split('\n');
  let cur = null;
  let hunkNew = 0;
  let inHunk = false;

  const commit = () => {
    if (cur && cur.path) {
      result.set(cur.path, {
        isNew: cur.isNew,
        isDeleted: cur.isDeleted,
        addedLines: cur.addedLines,
        deletionsByNewLine: cur.deletionsByNewLine,
        insertions: cur.insertions,
        deletions: cur.deletions,
      });
    }
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      commit();
      cur = {
        path: null,
        isNew: false,
        isDeleted: false,
        addedLines: new Set(),
        deletionsByNewLine: new Map(),
        insertions: 0,
        deletions: 0,
      };
      inHunk = false;
      continue;
    }
    if (!cur) continue;

    if (line.startsWith('new file mode')) cur.isNew = true;
    else if (line.startsWith('deleted file mode')) cur.isDeleted = true;
    else if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      cur.path = p === '/dev/null' ? null : (p.startsWith('b/') ? p.slice(2) : p);
    } else if (line.startsWith('--- ')) {
      // ignore, path bereits über +++ ermittelt
    } else if (line.startsWith('@@')) {
      const m = line.match(/@@\s-\d+(?:,\d+)?\s\+(\d+)(?:,\d+)?\s@@/);
      hunkNew = m ? parseInt(m[1], 10) : 1;
      inHunk = true;
    } else if (inHunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        cur.addedLines.add(hunkNew);
        cur.insertions++;
        hunkNew++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        const key = hunkNew;
        if (!cur.deletionsByNewLine.has(key)) cur.deletionsByNewLine.set(key, []);
        cur.deletionsByNewLine.get(key).push(line.slice(1));
        cur.deletions++;
      } else if (line.startsWith(' ')) {
        hunkNew++;
      }
      // '\ No newline at end of file' und Leerzeilen ignorieren
    }
  }
  commit();
  return result;
}

async function loadDiffForOutput(scenarioSub, framework) {
  const dir = path.join(OUTPUTS_DIR, framework, scenarioSub);
  const candidates = ['diff.uncommitted.patch', 'diff.patch'];
  let patch = '';
  for (const name of candidates) {
    try {
      const buf = await fs.readFile(path.join(dir, name), 'utf8');
      if (buf.trim().length > 0) {
        patch += (patch ? '\n' : '') + buf;
      }
    } catch {
      // existiert nicht, ignorieren
    }
  }
  return patch ? parseUnifiedDiff(patch) : new Map();
}

// ---------- Datei-Sammlung & Baum ----------

async function collectFiles(rootDir) {
  const entries = await fg('**/*', {
    cwd: rootDir,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
  });
  entries.sort((a, b) => {
    const da = a.split('/').length;
    const db = b.split('/').length;
    if (da !== db) return da - db;
    return a.localeCompare(b, 'de');
  });
  return entries.map((rel) => ({ relPath: rel, absPath: path.join(rootDir, rel) }));
}

function buildTree(files) {
  const root = { name: '', type: 'folder', children: new Map() };
  for (const f of files) {
    const parts = f.relPath.split('/');
    let node = root;
    parts.forEach((part, idx) => {
      const isLast = idx === parts.length - 1;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          type: isLast ? 'file' : 'folder',
          children: new Map(),
          file: isLast ? f : null,
        });
      }
      node = node.children.get(part);
    });
  }
  return root;
}

function renderTree(node, fileIdMap, fileStats, depth = 0) {
  if (node.type === 'file') {
    const id = fileIdMap.get(node.file.relPath);
    const stat = fileStats.get(node.file.relPath);
    const indent = '<span class="indent"></span>'.repeat(depth);
    const statBadge = stat
      ? `<span class="stat"><span class="stat-add">+${stat.insertions}</span><span class="stat-del">−${stat.deletions}</span></span>`
      : '';
    return `<li><div class="file" data-target="${id}">${indent}<span class="chevron"></span><span class="icon">◧</span><span class="fname">${escapeHtml(node.name)}</span>${statBadge}</div></li>`;
  }
  const children = [...node.children.values()]
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, 'de');
    })
    .map((c) => renderTree(c, fileIdMap, fileStats, depth + 1))
    .join('');
  if (depth === 0) {
    return `<ul class="tree">${children}</ul>`;
  }
  const indent = '<span class="indent"></span>'.repeat(depth - 1);
  return `<li class="folder"><div class="label">${indent}<span class="chevron"></span><span class="icon">▦</span><span>${escapeHtml(node.name)}</span></div><ul>${children}</ul></li>`;
}

// ---------- Shiki-Rendering ----------

function tokenizeLines(highlighter, code, lang) {
  try {
    const { tokens } = highlighter.codeToTokens(code, { lang, theme: 'dark-plus' });
    return tokens;
  } catch {
    // Fallback: eine Zeile = ein Text-Token
    return code.split('\n').map((line) => [{ content: line, color: '#D4D4D4' }]);
  }
}

function renderTokenLine(tokens) {
  return tokens
    .map((t) => `<span style="color:${t.color}">${escapeHtml(t.content)}</span>`)
    .join('');
}

// ---------- Diff-Pane rendern ----------

function renderPane({ id, relPath, meta, rows, stats, marks, totalRows }) {
  const statsHtml = stats
    ? `<span class="stat-inline"><span class="stat-add">+${stats.insertions}</span>&nbsp;<span class="stat-del">−${stats.deletions}</span></span>`
    : '';
  const marksAttr = escapeHtml(JSON.stringify(marks));
  return `<div class="code-pane" id="${id}" data-path="${escapeHtml(relPath)}" data-meta="${escapeHtml(meta)}" data-total="${totalRows}" data-marks="${marksAttr}"><div class="diff-view">${rows.join('')}</div><div class="pane-footer">${statsHtml}</div></div>`;
}

// Liefert Rows als HTML-Strings + Marks-Liste für den Overview-Ruler
function buildRows(content, diffInfo, highlighter, lang, allAddedFallback) {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const tokens = tokenizeLines(highlighter, content, lang);
  const rows = [];
  const marks = [];
  let curMark = null;

  const pushRow = (type, gutter, marker, html) => {
    const idx = rows.length;
    rows.push(
      `<div class="row row-${type}" data-i="${idx}"><span class="gutter">${gutter}</span><span class="marker">${marker}</span><span class="content">${html}</span></div>`
    );
    if (type === 'add' || type === 'del') {
      if (curMark && curMark.k === type && curMark.e === idx - 1) {
        curMark.e = idx;
      } else {
        if (curMark) marks.push(curMark);
        curMark = { k: type, s: idx, e: idx };
      }
    } else {
      if (curMark) { marks.push(curMark); curMark = null; }
    }
  };

  const isFullyNew = diffInfo?.isNew || allAddedFallback;

  for (let i = 0; i < lines.length; i++) {
    const newLineNum = i + 1;

    if (diffInfo && diffInfo.deletionsByNewLine.has(newLineNum)) {
      for (const delContent of diffInfo.deletionsByNewLine.get(newLineNum)) {
        const delTokens = tokenizeLines(highlighter, delContent, lang)[0] || [{ content: delContent, color: '#D4D4D4' }];
        pushRow('del', '·', '-', renderTokenLine(delTokens));
      }
    }

    const lineTokens = tokens[i] || [{ content: lines[i], color: '#D4D4D4' }];
    if (isFullyNew || diffInfo?.addedLines.has(newLineNum)) {
      pushRow('add', String(newLineNum), '+', renderTokenLine(lineTokens));
    } else {
      pushRow('ctx', String(newLineNum), '&nbsp;', renderTokenLine(lineTokens));
    }
  }

  if (diffInfo) {
    for (const [key, dels] of diffInfo.deletionsByNewLine.entries()) {
      if (key > lines.length) {
        for (const delContent of dels) {
          const delTokens = tokenizeLines(highlighter, delContent, lang)[0] || [{ content: delContent, color: '#D4D4D4' }];
          pushRow('del', '·', '-', renderTokenLine(delTokens));
        }
      }
    }
  }

  if (curMark) marks.push(curMark);

  return { rows, marks, totalRows: rows.length };
}

// ---------- Seite rendern ----------

function pageTemplate({ title, sidebarTitle, treeHtml, panesHtml, firstId, fileCount, totalIns, totalDel }) {
  const totalsBadge =
    totalIns != null
      ? `<div class="totals"><span class="stat-add">+${totalIns}</span>&nbsp;<span class="stat-del">−${totalDel}</span> Zeilen</div>`
      : '';
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="Code-Output für Bachelor-Thesis-Umfrage (anonymisiert).">
<meta property="og:type" content="website">
<link rel="stylesheet" href="../../assets/styles.css">
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="sidebar-header">
      <div class="title">${escapeHtml(sidebarTitle)}</div>
      <div>${fileCount} Datei${fileCount === 1 ? '' : 'en'}</div>
      ${totalsBadge}
    </div>
    ${treeHtml}
    <div class="footer-note">
      Grün = vom Agenten hinzugefügt. Rot = entfernt. Ohne Markierung = unverändert.<br>
      Anonymisierter Output, Bachelor-Thesis (DHSH).
    </div>
  </aside>
  <main class="content">
    <div class="tabbar">
      <div class="path" id="current-path"></div>
      <div class="meta" id="current-meta"></div>
    </div>
    ${panesHtml}
  </main>
  <div class="overview-ruler"><div class="ruler-inner" id="ruler"><div class="ruler-thumb" id="ruler-thumb"></div></div></div>
</div>
<script>
(function(){
  var firstId = ${JSON.stringify(firstId)};
  var ruler = document.getElementById('ruler');
  var thumb = document.getElementById('ruler-thumb');
  var content = document.querySelector('.content');
  var scrolling = false;

  function buildRuler(pane){
    // Marks aufbauen
    Array.prototype.slice.call(ruler.querySelectorAll('.ruler-mark')).forEach(function(m){ m.remove(); });
    var total = parseInt(pane.dataset.total, 10) || 1;
    var marks = [];
    try { marks = JSON.parse(pane.dataset.marks || '[]'); } catch(e) { marks = []; }
    marks.forEach(function(m){
      var topPct = (m.s / total) * 100;
      var heightPct = Math.max(0.25, ((m.e - m.s + 1) / total) * 100);
      var d = document.createElement('div');
      d.className = 'ruler-mark mark-' + m.k;
      d.style.top = topPct + '%';
      d.style.height = heightPct + '%';
      d.title = (m.k === 'add' ? '+' : '−') + ' ab Zeile ' + (m.s + 1);
      d.addEventListener('click', function(ev){
        ev.stopPropagation();
        var row = pane.querySelector('.row[data-i="' + m.s + '"]');
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      ruler.appendChild(d);
    });
  }

  function updateThumb(){
    var pane = document.querySelector('.code-pane.active');
    if (!pane) { thumb.style.display = 'none'; return; }
    var diff = pane.querySelector('.diff-view');
    if (!diff) { thumb.style.display = 'none'; return; }
    thumb.style.display = 'block';
    var paneTop = pane.offsetTop;
    var paneHeight = diff.offsetHeight;
    if (paneHeight <= 0) return;
    var startFrac = Math.max(0, (content.scrollTop - paneTop) / paneHeight);
    var endFrac = Math.min(1, (content.scrollTop - paneTop + content.clientHeight) / paneHeight);
    if (endFrac <= 0 || startFrac >= 1) {
      thumb.style.display = 'none'; return;
    }
    thumb.style.top = (startFrac * 100) + '%';
    thumb.style.height = Math.max(2, (endFrac - startFrac) * 100) + '%';
  }

  // Klick auf leeren Bereich des Rulers = Sprung
  ruler.addEventListener('click', function(ev){
    if (ev.target !== ruler && !ev.target.classList.contains('ruler-thumb')) return;
    var pane = document.querySelector('.code-pane.active');
    if (!pane) return;
    var rect = ruler.getBoundingClientRect();
    var frac = (ev.clientY - rect.top) / rect.height;
    var diff = pane.querySelector('.diff-view');
    if (!diff) return;
    content.scrollTop = pane.offsetTop + frac * diff.offsetHeight - content.clientHeight / 2;
  });

  function activate(id){
    document.querySelectorAll('.code-pane').forEach(function(p){ p.classList.toggle('active', p.id === id); });
    document.querySelectorAll('.tree .file').forEach(function(f){ f.classList.toggle('active', f.dataset.target === id); });
    var active = document.getElementById(id);
    if (active){
      document.getElementById('current-path').textContent = active.dataset.path || '';
      document.getElementById('current-meta').textContent = active.dataset.meta || '';
      buildRuler(active);
    }
    content.scrollTop = 0;
    updateThumb();
  }

  document.querySelectorAll('.tree .file').forEach(function(f){
    f.addEventListener('click', function(){ activate(f.dataset.target); });
  });
  document.querySelectorAll('.tree .folder > .label').forEach(function(l){
    l.addEventListener('click', function(){ l.parentElement.classList.toggle('collapsed'); });
  });

  content.addEventListener('scroll', function(){
    if (scrolling) return;
    scrolling = true;
    requestAnimationFrame(function(){ updateThumb(); scrolling = false; });
  });
  window.addEventListener('resize', updateThumb);

  if (firstId) activate(firstId);
})();
</script>
</body>
</html>
`;
}

// ---------- Haupt-Build ----------

async function main() {
  console.log('> Lese Anonymisierungs-Mapping …');
  const mapping = await loadMapping();

  console.log('> Lade AL-Grammar aus VS-Code-Extension …');
  const { grammar, source } = await loadAlGrammar();
  console.log('  gefunden: ' + source);

  console.log('> Initialisiere Shiki (dark-plus) …');
  const highlighter = await createHighlighter({
    themes: ['dark-plus'],
    langs: ['json', 'markdown', 'xml', 'yaml'],
  });
  const alLang = { ...grammar, name: 'al', scopeName: 'source.al' };
  delete alLang.aliases;
  await highlighter.loadLanguage(alLang);

  console.log('> Räume docs/ auf …');
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(path.join(OUT_DIR, 'assets'), { recursive: true });
  const cssSrc = await fs.readFile(path.join(ASSETS_SRC, 'styles.css'), 'utf8');
  await fs.writeFile(path.join(OUT_DIR, 'assets', 'styles.css'), cssSrc, 'utf8');

  const indexEntries = [];

  for (const scenario of SCENARIOS) {
    const scenarioDir = path.join(UMFRAGE_DIR, scenario.dir);
    const scenarioMapping = mapping[scenario.slug];

    for (const framework of FRAMEWORKS) {
      const outputSlug = scenarioMapping[framework];
      if (!outputSlug) continue;

      const frameworkDir = path.join(scenarioDir, framework);
      try { await fs.access(frameworkDir); } catch { continue; }

      const files = await collectFiles(frameworkDir);
      if (files.length === 0) continue;

      // Szenario A: echten Diff laden. Szenario B: alle Files gelten als neu.
      const diffMap =
        scenario.slug === 'szenario-a'
          ? await loadDiffForOutput(scenario.outputsSub, framework)
          : new Map();
      const treatAllAsNew = scenario.slug === 'szenario-b';

      const fileIdMap = new Map();
      const fileStats = new Map();
      const panes = [];
      let firstId = null;
      let totalIns = 0;
      let totalDel = 0;

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const id = 'f' + i;
        fileIdMap.set(f.relPath, id);
        if (!firstId) firstId = id;

        const content = await fs.readFile(f.absPath, 'utf8');
        const lang = languageForFile(f.relPath);
        const diffInfo = diffMap.get(f.relPath) || null;

        let ins = 0, del = 0;
        if (diffInfo) {
          ins = diffInfo.insertions;
          del = diffInfo.deletions;
        } else if (treatAllAsNew) {
          ins = content.split('\n').length;
          if (content.endsWith('\n')) ins = Math.max(0, ins - 1);
        }
        totalIns += ins;
        totalDel += del;

        const stats = ins || del ? { insertions: ins, deletions: del } : null;
        fileStats.set(f.relPath, stats);

        const built = buildRows(content, diffInfo, highlighter, lang, treatAllAsNew);
        const meta = `${lang.toUpperCase()} · ${content.split('\n').length} Zeilen`;

        panes.push(renderPane({
          id,
          relPath: f.relPath,
          meta,
          rows: built.rows,
          stats,
          marks: built.marks,
          totalRows: built.totalRows,
        }));
      }

      const tree = buildTree(files);
      const treeHtml = renderTree(tree, fileIdMap, fileStats, 0);

      const title = `${scenario.label} — ${outputSlug.replace('output-', 'Output ')}`;
      const pageHtml = pageTemplate({
        title,
        sidebarTitle: title,
        treeHtml,
        panesHtml: panes.join('\n'),
        firstId,
        fileCount: files.length,
        totalIns,
        totalDel,
      });

      const pageDir = path.join(OUT_DIR, scenario.slug, outputSlug);
      await fs.mkdir(pageDir, { recursive: true });
      await fs.writeFile(path.join(pageDir, 'index.html'), pageHtml, 'utf8');

      indexEntries.push({
        scenario: scenario.label,
        outputSlug,
        url: `${scenario.slug}/${outputSlug}/`,
        fileCount: files.length,
        totalIns,
        totalDel,
      });

      console.log(`  ✓ ${scenario.slug}/${outputSlug}  (${files.length} Dateien, +${totalIns}/-${totalDel})`);
    }
  }

  indexEntries.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.outputSlug.localeCompare(b.outputSlug));
  const indexHtml = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<title>Survey Outputs (intern)</title>
<link rel="stylesheet" href="assets/styles.css">
<style>body{padding:32px;overflow:auto;}h1{color:#fff;}a{color:#4ea3e0;}li{margin:6px 0;}</style>
</head><body>
<h1>Survey Outputs (intern, anonymisiert)</h1>
<p>Diese Index-Seite ist nur für dich. Probanden erhalten nur die Deep-Links aus Tally.</p>
<ul>
${indexEntries
  .map(
    (e) =>
      `<li><strong>${escapeHtml(e.scenario)}</strong> – <a href="${e.url}">${e.outputSlug}</a> <span style="color:#999">(${e.fileCount} Dateien, +${e.totalIns}/-${e.totalDel})</span></li>`
  )
  .join('\n')}
</ul>
</body></html>`;
  await fs.writeFile(path.join(OUT_DIR, 'index.html'), indexHtml, 'utf8');
  await fs.writeFile(path.join(OUT_DIR, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8');

  console.log('\n> Fertig. Output in: ' + OUT_DIR);
  console.log('> Lokal testen:   npm run serve');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
