"""Check label SDK fixture path boundaries before any copy or output creation."""

from pathlib import Path
import tempfile
import unittest

from numeric_sdk_fixture import ROOT, prepare_label


class LabelFixturePaths(unittest.TestCase):
    def test_ndk_cannot_contain_fixture_workspace(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            with self.assertRaisesRegex(ValueError, "must not overlap"):
                prepare_label(output, ROOT)
            self.assertFalse(output.exists())

    def test_output_cannot_overlap_ndk(self):
        with tempfile.TemporaryDirectory() as temporary:
            ndk = Path(temporary) / "ndk"
            ndk.mkdir()
            output = ndk / "output"
            with self.assertRaisesRegex(ValueError, "must not overlap"):
                prepare_label(output, ndk)
            self.assertFalse(output.exists())

    def test_ndk_cannot_link_to_fixture_workspace(self):
        with tempfile.TemporaryDirectory() as temporary:
            ndk = Path(temporary) / "ndk"
            ndk.mkdir()
            (ndk / "recursive-link").symlink_to(ROOT / "target/validator", target_is_directory=True)
            output = Path(temporary) / "output"
            with self.assertRaisesRegex(ValueError, "must not contain symbolic links"):
                prepare_label(output, ndk)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
