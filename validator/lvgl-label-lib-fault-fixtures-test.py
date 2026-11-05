"""Check that fixture generation never replaces an existing output path."""

from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "validator/lvgl-label-lib-fault-fixtures.py"


def main() -> None:
    with tempfile.TemporaryDirectory(prefix=".label-lib-fault-test-", dir=ROOT / "target") as temporary:
        parent = Path(temporary)
        existing = parent / "existing"
        existing.mkdir()
        marker = existing / "marker"
        marker.write_bytes(b"preserve")
        link = parent / "link"
        link.symlink_to(existing, target_is_directory=True)
        for output in (existing, marker, link):
            result = subprocess.run([sys.executable, "-B", str(GENERATOR), str(output)], capture_output=True)
            if result.returncode == 0 or marker.read_bytes() != b"preserve":
                raise AssertionError(f"existing output was accepted: {output}")
        if sorted(item.name for item in existing.iterdir()) != ["marker"]:
            raise AssertionError("existing directory was modified")


if __name__ == "__main__":
    main()
