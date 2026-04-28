// build.mjs — Statische Survey-Seite bauen
// Liest Umfrage/Szenario A/* und Umfrage/Szenario B/*, rendert mit Shiki + AL-Grammar,
// gibt eine HTML-Seite pro Framework × Szenario nach docs/<slug>/<output>/ aus.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';
import plist from 'plist';
import { createHighlighter } from 'shiki';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UMFRAGE_DIR = path.join(ROOT, 'Umfrage');
const OUT_DIR = path.join(__dirname, 'docs');
const ASSETS_SRC = path.join(__dirname, 'assets');

const SCENARIOS = [
  { label: 'Szenario A', dir: 'Szenario A', slug: 'szenario-a' },
  { label: 'Szenario B', dir: 'Szenario B', slug: 'szenario-b' },
];

const FRAMEWORKS = ['claude', 'codex', 'copilot', 'cursor', 'gemini'];

// ---------- Hilfsfunktionen ----------

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
  candidates.sort().reverse(); // neueste Version
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

async function collectFiles(rootDir) {
  // Liefert eine flache Liste {relPath, absPath} für alle Dateien unterhalb rootDir
  const entries = await fg('**/*', {
    cwd: rootDir,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
  });
  entries.sort((a, b) => {
    // Ordner-Tiefe zuerst nach Verzeichnis, dann alphabetisch
    const da = a.split('/').length;
    const db = b.split('/').length;
    if (da !== db) return da - db;
    return a.localeCompare(b, 'de');
  });
  return entries.map((rel) => ({
    relPath: rel,
    absPath: path.join(rootDir, rel),
  }));
}

// ---------- Baum aus flacher Liste ----------

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

function renderTree(node, fileIdMap, depth = 0) {
  if (node.type === 'file') {
    const id = fileIdMap.get(node.file.relPath);
    const indent = '<span class="indent"></span>'.repeat(depth);
    return `<li><div class="file" data-target="${id}">${indent}<span class="chevron"></span><span class="icon">◧</span><span>${escapeHtml(node.name)}</span></div></li>`;
  }
  // folder
  const children = [...node.children.values()]
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, 'de');
    })
    .map((c) => renderTree(c, fileIdMap, depth + 1))
    .join('');
  if (depth === 0) {
    return `<ul class="tree">${children}</ul>`;
  }
  const indent = '<span class="indent"></span>'.repeat(depth - 1);
  return `<li class="folder"><div class="label">${indent}<span class="chevron"></span><span class="icon">▦</span><span>${escapeHtml(node.name)}</span></div><ul>${children}</ul></li>`;
}

// ---------- Seite rendern ----------

function pageTemplate({ title, sidebarTitle, treeHtml, panesHtml, firstId, fileCount }) {
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
    </div>
    ${treeHtml}
    <div class="footer-note">
      Anonymisierter Code-Output einer Agentic-AI-Framework-Evaluation.<br>
      Bachelor-Thesis, DHSH — Nicolas.
    </div>
  </aside>
  <main class="content">
    <div class="tabbar">
      <div class="path" id="current-path"></div>
      <div class="meta" id="current-meta"></div>
    </div>
    ${panesHtml}
  </main>
</div>
<script>
(function(){
  var firstId = ${JSON.stringify(firstId)};
  function activate(id){
    document.querySelectorAll('.code-pane').forEach(function(p){ p.classList.toggle('active', p.id === id); });
    document.querySelectorAll('.tree .file').forEach(function(f){ f.classList.toggle('active', f.dataset.target === id); });
    var active = document.getElementById(id);
    if (active){
      document.getElementById('current-path').textContent = active.dataset.path || '';
      document.getElementById('current-meta').textContent = active.dataset.meta || '';
    }
    document.querySelector('.content').scrollTop = 0;
  }
  document.querySelectorAll('.tree .file').forEach(function(f){
    f.addEventListener('click', function(){ activate(f.dataset.target); });
  });
  document.querySelectorAll('.tree .folder > .label').forEach(function(l){
    l.addEventListener('click', function(){ l.parentElement.classList.toggle('collapsed'); });
  });
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

  console.log('> Initialisiere Shiki mit Theme dark-plus …');
  const highlighter = await createHighlighter({
    themes: ['dark-plus'],
    langs: ['json', 'markdown', 'xml', 'yaml'],
  });
  // Shiki erwartet `name` als den registrierten Bezeichner. Plist liefert oft "AL"
  // (Großbuchstaben) – wir überschreiben auf 'al' und verzichten auf Aliase, um
  // die Fehlermeldung "Circular alias al -> al" zu vermeiden.
  const alLang = { ...grammar, name: 'al', scopeName: 'source.al' };
  delete alLang.aliases;
  await highlighter.loadLanguage(alLang);

  console.log('> Räume docs/ auf …');
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  // Assets kopieren
  await fs.mkdir(path.join(OUT_DIR, 'assets'), { recursive: true });
  const cssSrc = await fs.readFile(path.join(ASSETS_SRC, 'styles.css'), 'utf8');
  await fs.writeFile(path.join(OUT_DIR, 'assets', 'styles.css'), cssSrc, 'utf8');

  const indexEntries = [];

  for (const scenario of SCENARIOS) {
    const scenarioDir = path.join(UMFRAGE_DIR, scenario.dir);
    const scenarioMapping = mapping[scenario.slug];

    for (const framework of FRAMEWORKS) {
      const outputSlug = scenarioMapping[framework];
      if (!outputSlug) {
        console.warn(`  [warn] kein Mapping für ${scenario.slug}/${framework}`);
        continue;
      }

      const frameworkDir = path.join(scenarioDir, framework);
      try {
        await fs.access(frameworkDir);
      } catch {
        console.warn(`  [warn] Ordner fehlt: ${frameworkDir}`);
        continue;
      }

      const files = await collectFiles(frameworkDir);
      if (files.length === 0) {
        console.warn(`  [warn] keine Dateien: ${frameworkDir}`);
        continue;
      }

      const fileIdMap = new Map();
      const panes = [];
      let firstId = null;

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const id = 'f' + i;
        fileIdMap.set(f.relPath, id);
        if (!firstId) firstId = id;

        const content = await fs.readFile(f.absPath, 'utf8');
        const lang = languageForFile(f.relPath);
        let highlighted;
        try {
          highlighted = highlighter.codeToHtml(content, {
            lang,
            theme: 'dark-plus',
          });
        } catch (err) {
          console.warn(`  [warn] Highlighting fallback für ${f.relPath} (${lang}): ${err.message}`);
          highlighted = `<pre class="shiki"><code>${escapeHtml(content)}</code></pre>`;
        }

        const lines = content.split('\n').length;
        const meta = `${lang.toUpperCase()} · ${lines} Zeilen`;
        panes.push(
          `<div class="code-pane" id="${id}" data-path="${escapeHtml(f.relPath)}" data-meta="${escapeHtml(meta)}">${highlighted}</div>`
        );
      }

      const tree = buildTree(files);
      const treeHtml = renderTree(tree, fileIdMap, 0);

      const title = `${scenario.label} — ${outputSlug.replace('output-', 'Output ')}`;
      const pageHtml = pageTemplate({
        title,
        sidebarTitle: title,
        treeHtml,
        panesHtml: panes.join('\n'),
        firstId,
        fileCount: files.length,
      });

      const pageDir = path.join(OUT_DIR, scenario.slug, outputSlug);
      await fs.mkdir(pageDir, { recursive: true });
      await fs.writeFile(path.join(pageDir, 'index.html'), pageHtml, 'utf8');

      indexEntries.push({
        scenario: scenario.label,
        outputSlug,
        url: `${scenario.slug}/${outputSlug}/`,
        fileCount: files.length,
      });

      console.log(`  ✓ ${scenario.slug}/${outputSlug}  (${files.length} Dateien)`);
    }
  }

  // Minimale index.html (intern, mit noindex)
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
${indexEntries.map((e) => `<li><strong>${escapeHtml(e.scenario)}</strong> – <a href="${e.url}">${e.outputSlug}</a> <span style="color:#999">(${e.fileCount} Dateien)</span></li>`).join('\n')}
</ul>
</body></html>`;
  await fs.writeFile(path.join(OUT_DIR, 'index.html'), indexHtml, 'utf8');

  // robots.txt: alles auf noindex
  await fs.writeFile(path.join(OUT_DIR, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8');

  console.log('\n> Fertig. Output in: ' + OUT_DIR);
  console.log('> Lokal testen:   npm run serve');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
