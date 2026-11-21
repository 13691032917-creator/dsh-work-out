"""Validate the registry entry locally before opening the PR.

Checks mirror the documented submission gates we can check without network:
one YAML file, exact repo name in url/name, allowed category, quoted-safe
descriptions, icon on GitHub raw with an accepted raster extension.
"""
import io, os, re

market = os.path.dirname(os.path.abspath(__file__))
files = [f for f in os.listdir(market) if f.endswith(('.yml', '.yaml'))]
assert len(files) == 1, f"expected exactly one entry file, got {files}"
entry_file = files[0]
text = io.open(os.path.join(market, entry_file), encoding="utf-8").read()

owner, repo = "13691032917-creator", "dsh-work-out"
assert entry_file == f"{owner}__{repo}.yml", f"wrong filename: {entry_file}"

def field(name):
    m = re.search(rf"^{name}:\s*(.+)$", text, re.M)
    return m.group(1).strip() if m else None

url, name = field("url"), field("name")
assert url == f"https://github.com/{owner}/{repo}", f"url mismatch: {url}"
assert name == f"{owner}/{repo}", f"name mismatch: {name}"

category = field("category")
allowed = set("agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun".split())
assert category in allowed, f"bad category: {category}"

# Descriptions: each must exist; a colon in a scalar must be quoted.
for lang in ("en", "zh"):
    m = re.search(rf"^  {lang}:\s*(.+)$", text, re.M)
    assert m, f"missing description.{lang}"
    value = m.group(1).strip()
    if ":" in value and not (value.startswith(("'", '"'))):
        raise AssertionError(f"description.{lang} contains ':' but is not quoted")

icon = field("icon")
assert icon.startswith("https://raw.githubusercontent.com/"), "icon must be GitHub-hosted raw"
assert re.search(r"\.(png|jpe?g|webp)$", icon), "icon must be an accepted raster"
assert f"/{repo}/" in icon and "icon-180.png" in icon, "icon path mismatch"

print("REGISTRY ENTRY: PASS")
print(f"  file:     data/plugins/{entry_file}")
print(f"  url:      {url}")
print(f"  category: {category}")
print(f"  icon:     {icon}")