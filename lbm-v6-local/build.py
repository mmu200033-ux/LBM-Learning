"""Rebuild the local v6 app without changing the approved fragment's HTML/CSS."""
from pathlib import Path
import html
import json
import re

ROOT = Path(__file__).resolve().parent
fragment = (ROOT / 'original-fragment.html').read_text(encoding='utf-8')
export = (ROOT / 'original-export.html').read_text(encoding='utf-8')
data_pattern = r'(<script type="application/json" id="lbm-v6-snapshots">)([\s\S]*?)(</script>)'
original_data = json.loads(re.search(data_pattern, fragment).group(2))
seed = {key: original_data[key] for key in ('nx', 'ny', 'n', 'solid')}
seed['stages'] = [original_data['stages'][0]]
updated = re.sub(data_pattern, lambda m: m[1] + json.dumps(seed, separators=(',', ':')) + m[3], fragment, count=1)
# The approved v6 control stays identical in appearance; only its upper speed
# bound is extended for the local interactive build.
updated = updated.replace('aria-label="演示速度" type="range" min="0.5" max="10" step="0.5" value="1"',
                          'aria-label="演示速度" type="range" min="0.5" max="100" step="0.5" value="1"', 1)
scripts = '\n'.join((ROOT / name).read_text(encoding='utf-8') for name in ('engine.js', 'ui.js'))
assert '</script' not in scripts.lower()
updated, count = re.subn(r'<script>\s*\(\(\)=>\{[\s\S]*?</script>', lambda m: '<script>\n' + scripts + '\n</script>', updated, count=1)
assert count == 1

match = re.search(r'data-srcdoc="([\s\S]*?)"\s*></iframe>', export)
inner = html.unescape(match.group(1))
assert fragment in inner
inner = inner.replace(fragment, updated, 1)
# The exported frame was constrained for a chat bubble. Let the unmodified v6
# layout use the local browser width; preserve its sandbox and both CSPs.
result = export[:match.start(1)] + html.escape(inner, quote=True) + export[match.end(1):]
result = result.replace('max-width:736px', 'max-width:1320px', 1)
result = result.replace('<title>lbm-minimal-v6.html</title>', '<title>LBM / 流体实验室 · 本地 v6</title>', 1)
(ROOT / 'index.html').write_text(result, encoding='utf-8')

# Guard against accidentally rebuilding from one of the rejected designs.
original_style = re.search(r'<style>([\s\S]*?)</style>', fragment).group(1)
new_style = re.search(r'<style>([\s\S]*?)</style>', updated).group(1)
assert original_style == new_style
assert 'sandbox="allow-scripts"' in result
assert len(re.findall(r'Content-Security-Policy', result)) == 2
print('Built index.html; original v6 component CSS unchanged; sandbox + CSP preserved.')
