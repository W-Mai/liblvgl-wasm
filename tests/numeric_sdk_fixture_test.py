"""Check label SDK fixture path boundaries before any copy or output creation."""

from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

from numeric_sdk_fixture import ROOT, prepare_chain, prepare_event, prepare_label, scratch_target


class LabelFixturePaths(unittest.TestCase):
    def test_scratch_cannot_leave_validator_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.dict(os.environ, {"LVW_TEST_SDK_SCRATCH": temporary}):
                with self.assertRaisesRegex(ValueError, "must be under target/validator"):
                    scratch_target()

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

    def test_event_output_cannot_overlap_ndk(self):
        with tempfile.TemporaryDirectory() as temporary:
            ndk = Path(temporary) / "ndk"
            ndk.mkdir()
            output = ndk / "output"
            with self.assertRaisesRegex(ValueError, "must not overlap"):
                prepare_event(output, ndk)
            self.assertFalse(output.exists())

    def test_chain_output_cannot_overlap_ndk(self):
        with tempfile.TemporaryDirectory() as temporary:
            ndk = Path(temporary) / "ndk"
            ndk.mkdir()
            output = ndk / "output"
            with self.assertRaisesRegex(ValueError, "must not overlap"):
                prepare_chain(output, ndk)
            self.assertFalse(output.exists())

    def test_chain_ndk_cannot_contain_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            ndk = Path(temporary) / "ndk"
            ndk.mkdir()
            (ndk / "recursive-link").symlink_to(ROOT / "target/validator", target_is_directory=True)
            output = Path(temporary) / "output"
            with self.assertRaisesRegex(ValueError, "must not contain symbolic links"):
                prepare_chain(output, ndk)
            self.assertFalse(output.exists())

    def test_chain_existing_graph_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            ndk = Path(temporary) / "ndk"
            ndk.mkdir()
            output = Path(temporary) / "output"
            output.mkdir()
            graph = output / "graph.json"
            graph.write_bytes(b"user data")
            with self.assertRaisesRegex(FileExistsError, "already exists"):
                prepare_chain(output, ndk)
            self.assertEqual(graph.read_bytes(), b"user data")

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
