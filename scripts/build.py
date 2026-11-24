"""Build a reproducible unpacked-extension ZIP and verify its contents."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
version = manifest["version"]
if version != json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]:
    raise ValueError("Package and manifest versions differ")

files = [root / "manifest.json", root / "README.md"]
for pattern in ("*.js", "*.html", "*.css", "media/*.js", "vendor/*.min.js", "vendor/*.min.mjs", "vendor/*LICENSE.txt"):
    files.extend(root.glob(pattern))
package = root / f"bilibili-video-summary-{version}.zip"
with ZipFile(package, "w") as archive:
    for path in sorted(files):
        name = path.relative_to(root).as_posix()
        entry = ZipInfo(name, (2020, 1, 1, 0, 0, 0))
        entry.external_attr = 0o100644 << 16
        archive.writestr(entry, path.read_bytes().replace(b"\r\n", b"\n"), compress_type=ZIP_DEFLATED)
with ZipFile(package) as archive:
    assert archive.testzip() is None
    resources = [name for group in manifest["web_accessible_resources"] for name in group["resources"]]
    for entry in [manifest["background"]["service_worker"], manifest["side_panel"]["default_path"], "jobs.html", *resources]:
        assert entry in archive.namelist()
    print(f"{package.name} ({len(archive.namelist())} files, {package.stat().st_size} bytes)")
