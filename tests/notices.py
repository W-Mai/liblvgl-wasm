"""Verify source identity, byte preservation, and atomic notice publication."""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def check():
    with tempfile.TemporaryDirectory(prefix="lvw notice contract ") as temporary:
        root = Path(temporary).resolve()
        source, output = root / "source", root / "licenses"
        materials = root / "materials"
        shutil.copytree(ROOT / "third_party/runtime", materials / "runtime")
        pinned_path = materials / "runtime/manifest.json"
        pinned = json.loads(pinned_path.read_text())
        font = "FontAwesome5-Solid+Brands+Regular.woff"
        font_bytes = b"font identity fixture"
        pinned["lvgl"]["font_inputs"][font]["sha256"] = hashlib.sha256(font_bytes).hexdigest()
        generated = "src/font/generated.c"
        generated_bytes = b"generated font identity fixture"
        pinned["lvgl"]["font_inputs"][font]["generated_sources"] = {
            generated: hashlib.sha256(generated_bytes).hexdigest()}
        pinned_path.write_text(json.dumps(pinned))
        (source / "src").mkdir(parents=True)
        report = {"source": str(source), "version": {"major": 9, "minor": 0, "patch": 0}, "configuration": {}}
        manifest_path = output / "runtime/manifest.json"

        def collect(error=None, destination=None):
            (root / "report.json").write_text(json.dumps(report))
            result = subprocess.run([sys.executable, "-B", str(ROOT / "generator/notices.py"),
                                     "--source", str(source), "--materials", str(materials),
                                     "--report", str(root / "report.json"), "--output", str(destination or output)],
                                    capture_output=True, text=True)
            if error is None:
                assert result.returncode == 0, result.stdout + result.stderr
            else:
                assert result.returncode != 0 and error in result.stderr, (result.returncode, result.stdout, result.stderr)

        (source / "LICENCE.txt").write_bytes(b"Selected license\r\n")
        original = b"/* Copyright. License \xff */\r\n"
        (source / "src/old.c").write_bytes(original)
        collect()
        assert (output / "runtime/lvgl/src/old.c").read_bytes() == original
        assert not (output / "runtime/lvgl/COPYRIGHTS.md").exists()
        manifest = json.loads(manifest_path.read_text())
        assert manifest["schema_version"] == 2 and manifest["lvgl"]["version"] == "9.0.0"
        assert manifest["components"] == {}

        font_path = source / "scripts/built_in_font" / font
        font_path.parent.mkdir(parents=True)
        font_path.write_bytes(font_bytes)
        collect()
        supplements = json.loads(manifest_path.read_text())["lvgl"]["font_supplements"]
        assert len(supplements) == 1
        supplement = supplements[0]
        assert supplement["origin"] == pinned["lvgl"]["url"]
        assert supplement["inputs"] == {font_path.relative_to(source).as_posix(): hashlib.sha256(font_bytes).hexdigest()}
        assert (output / "runtime" / supplement["path"]).read_bytes() == (
            ROOT / "third_party/runtime/lvgl" / supplement["origin_path"]).read_bytes()

        previous = manifest_path.read_bytes()
        font_path.write_bytes(b"different font")
        collect("missing local notice for unverified font input")
        assert manifest_path.read_bytes() == previous
        notice = source / "scripts/built_in_font/font_license/FontAwesome5/LICENSE.txt"
        notice.parent.mkdir(parents=True)
        notice.write_text("Custom font license\n")
        (source / "src/old.c").unlink()
        (source / "src/current.c").write_text("/* License for current source */\n")
        report["version"]["minor"] = 1
        collect()
        assert not (output / "runtime/lvgl/src/old.c").exists()
        manifest = json.loads(manifest_path.read_text())
        assert manifest["lvgl"]["version"] == "9.1.0" and manifest["lvgl"]["font_supplements"] == []

        notice.unlink()
        font_path.unlink()
        generated_path = source / generated
        generated_path.parent.mkdir()
        generated_path.write_bytes(generated_bytes)
        collect()
        supplement = json.loads(manifest_path.read_text())["lvgl"]["font_supplements"][0]
        assert supplement["inputs"] == {generated: hashlib.sha256(generated_bytes).hexdigest()}
        previous = manifest_path.read_bytes()
        generated_path.write_bytes(b"unverified generated font")
        collect("missing local notice for unverified font input")
        assert manifest_path.read_bytes() == previous
        generated_path.unlink()

        link = source / "src/linked.h"
        link.symlink_to(source / "LICENCE.txt")
        collect("symbolic link")
        link.unlink()
        report["configuration"] = {"LV_USE_THORVG_INTERNAL": {"category": "integer", "value": "1"}}
        collect("requires matching supplemental materials")
        report["source"] = str(root)
        collect("belongs to a different source directory")
        report["source"] = str(source)
        collect("overlaps its inputs", source)
        unrelated = root / "unrelated"
        unrelated.mkdir()
        (unrelated / "keep").write_text("preserve")
        collect("not a generated notice tree", unrelated)
        assert (unrelated / "keep").read_text() == "preserve"
        link = root / "output-link"
        link.symlink_to(output, target_is_directory=True)
        collect("symbolic link", link)
    print("Selected-source notice contracts passed")


if __name__ == "__main__":
    check()
