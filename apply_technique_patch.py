#!/usr/bin/env python3
"""
Patch for ski-dashboard app.js (whitespace-tolerant).
  1. Adds a shared helper, techniqueShares(), for technique percentages.
  2. Coach & History "Technique distribution" divides by the sum of the technique
     counts (same as the Overview) instead of points.length.
  3. Removes the block in computeMetrics() that adds per-GPS-row heuristic counts on top
     of per-turn JSON counts (mixed units).

Usage:  python3 apply_technique_patch_v2.py app.js
Writes app.js.bak first. Nothing is written if any block is not found exactly once.
"""
import re, sys, pathlib, shutil

src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'app.js')
if not src.is_file():
    sys.exit(f'File not found: {src}')
raw = src.read_bytes().decode('utf-8')
crlf = '\r\n' in raw
text = raw.replace('\r\n', '\n')

if 'function techniqueShares' in text:
    sys.exit('Already patched (techniqueShares found). Nothing to do.')

HELPER = '''// Single source of truth for technique percentages: every panel divides by the
// sum of the technique counts, so all panels agree and add up to ~100%.
function techniqueShares(counts) {
  const entries = Object.entries(counts || {})
    .map(([name, count]) => [name, Math.max(0, Number(count) || 0)])
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0) || 1;
  return entries.map(([name, count]) => ({ name, count, pct: Math.round(count / total * 100) }));
}

'''

NEW_COACH = '''  if ($('techDistRows')) {
    // Same denominator as the Overview: the sum of the technique counts
    $('techDistRows').innerHTML = techniqueShares(metrics.techniqueCounts).map(({ name, pct }) => {
      return `<div class="tech-dist-row">
        <span class="tech-dist-name">${escapeDashboardText(name)}</span>
        <div class="tech-dist-track"><div class="tech-dist-fill" style="width:${pct}%"></div></div>
        <span class="tech-dist-pct">${pct}%</span>
      </div>`;
    }).join('');
  }
'''

NEW_MIX = '''  // When acquisition JSON is present, techniqueCounts is in TURNS. Rows without analytics are
  // not added here: mixing per-GPS-row heuristic counts into a per-turn count distorts the shares.
'''

R_HELPER = re.compile(r'function\s+renderBars\s*\(\s*\)\s*\{')
R_COACH = re.compile(r"[ \t]*if\s*\(\s*\$\('techDistRows'\)\s*\)\s*\{.*?\}\)\.join\(''\);\s*\}\n", re.S)
R_MIX = re.compile(
    r"[ \t]*if\s*\(\s*analyticsRecords\.length\s*\)\s*\{\s*"
    r"safeRows\.filter\(\s*point\s*=>\s*!point\.analytics_id\s*\)\.forEach\(\s*point\s*=>\s*\{\s*"
    r"const\s+technique\s*=\s*classifyTechnique\(point\);\s*"
    r"techniqueCounts\[technique\]\s*=\s*\(techniqueCounts\[technique\]\s*\|\|\s*0\)\s*\+\s*1;\s*"
    r"\}\);\s*\}\n")

def only_one(name, rx, check=None):
    found = list(rx.finditer(text))
    if len(found) != 1:
        sys.exit(f'[{name}] found {len(found)} times (expected 1). Nothing was written.')
    if check and not check(found[0].group(0)):
        sys.exit(f'[{name}] matched unexpected code. Nothing was written.')
    return found[0]

m_help = only_one('helper', R_HELPER)
m_coach = only_one('coach panel', R_COACH, lambda s: 'points.length' in s)
m_mix = only_one('mixed-unit fallback', R_MIX)

# apply from the end of the file backwards so earlier offsets stay valid
for m, new in sorted([(m_help, None), (m_coach, NEW_COACH), (m_mix, NEW_MIX)], key=lambda t: -t[0].start()):
    if new is None:  # helper: insert before renderBars
        text = text[:m.start()] + HELPER + text[m.start():]
    else:
        text = text[:m.start()] + new + text[m.end():]

shutil.copy2(src, str(src) + '.bak')
src.write_bytes((text.replace('\n', '\r\n') if crlf else text).encode('utf-8'))
print(f'Patched {src} (3 edits). Backup: {src}.bak')