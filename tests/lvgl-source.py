"""Verify that both public header layouts share one target compiler contract."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "generator"))
from api import declarations
from layouts import collect_layouts
from lvgl import SourceLayout, compiler_command, inspect_source
from signatures import collect_signatures


class SourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sdk = Path(subprocess.check_output(
            ["sh", str(ROOT / "scripts/resolve-wasi-sdk.sh"), str(ROOT)], text=True).strip())

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lvgl source ", dir=ROOT / "target")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = self.root / "config/lv_conf.h"
        self.config.parent.mkdir()
        self.config.write_text("#define LV_USE_TEST ((1 << 2) + 3)\n"
                               '#include "font-options.h"\n')
        (self.config.parent / "font-options.h").write_text(
            "#define LV_TINY_TTF_FILE_SUPPORT (LV_USE_TEST == 7)\n"
            "#define LV_FREETYPE_USE_LVGL_PORT 0\n"
            "#define LV_CACHE_DEF_SIZE (16 * 1024)\n"
            '#define LV_FONT_DEFAULT ((void *)0)\n')

    def source(self, layout, major="(8 + 1)"):
        source = self.root / layout
        public = source / "include/lvgl" if layout == "modern" else source
        public.mkdir(parents=True)
        header = public / "lvgl.h"
        header.write_text('#include "lv_conf.h"\n'
                          f"#define LVGL_VERSION_MAJOR {major}\n"
                          '#define LVGL_VERSION_MINOR 0\n#define LVGL_VERSION_PATCH 0\n'
                          '#define LVGL_VERSION_INFO "-fixture"\n'
                          'enum { LV_FIXTURE_ENUM = 11 };\n'
                          'typedef struct { int x; float y; } lv_point_t;\n'
                          'void lv_fixture(lv_point_t *point);\n')
        (public / "unused_private.h").write_text("void lv_not_public(void);\n")
        if layout == "modern":
            (source / "lvgl.h").write_text('#include "include/lvgl/lvgl.h"\n')
        return source

    def test_shared_compiler_graph_and_signatures(self):
        for layout in ("legacy", "modern"):
            with self.subTest(layout=layout):
                source = self.source(layout)
                before = {str(path): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
                report = inspect_source(source, self.config, self.sdk)
                self.assertEqual(report["version"], {"major": 9, "minor": 0, "patch": 0, "info": "-fixture"})
                self.assertEqual(report["configuration"]["LV_USE_TEST"]["value"], "7")
                self.assertEqual(report["configuration"]["LV_TINY_TTF_FILE_SUPPORT"]["value"], "1")
                self.assertEqual(report["configuration"]["LV_FREETYPE_USE_LVGL_PORT"]["value"], "0")
                self.assertEqual(report["configuration"]["LV_CACHE_DEF_SIZE"]["value"], "16384")
                self.assertNotIn("value", report["configuration"]["LV_FONT_DEFAULT"])
                self.assertNotIn("LV_FIXTURE_ENUM", report["configuration"])
                self.assertEqual(report["target"]["pointer_bits"], 32)
                self.assertEqual(report["runtime_verification"], "not-run")
                self.assertFalse(report["declaration_probes"]["display_create"]["declared"])
                self.assertEqual(before, {str(path): path.read_bytes() for path in self.root.rglob("*") if path.is_file()})
                command = compiler_command(self.sdk / "bin/clang", source, self.config)
                found = declarations(command, source)
                self.assertEqual(set(found), {"lv_fixture"})
                output = self.root / f"output-{layout}"
                types = collect_layouts(command, self.sdk, source, self.config.parent, set(found), output)
                self.assertEqual(set(types["function_types"]), set(found))
                signature = collect_signatures(command, [{"category": "direct_export", "export_name": "lv_fixture"}], [], output)
                self.assertEqual(signature, {"lv_fixture": {"params": ["i32"], "results": []}})

    def test_conflicting_entries_and_ignored_configuration(self):
        source = self.source("modern")
        wrapper = source / "lvgl.h"
        wrapper.write_text("#define LVGL_VERSION_MAJOR 9\n")
        with self.assertRaisesRegex(ValueError, "conflicting"):
            compiler_command(self.sdk / "bin/clang", source, self.config)

        wrapper.write_text('#include "include/lvgl/lvgl.h"\n#undef LVGL_VERSION_MAJOR\n#define LVGL_VERSION_MAJOR 10\n')
        with self.assertRaisesRegex(ValueError, "conflicting"):
            compiler_command(self.sdk / "bin/clang", source, self.config)
        wrapper.unlink()
        header = SourceLayout.discover(source).entry
        header.write_text(header.read_text().replace('#include "lv_conf.h"', ""))
        with self.assertRaisesRegex(ValueError, "selected public header and configuration"):
            compiler_command(self.sdk / "bin/clang", source, self.config)

    def test_installed_headers_cannot_depend_on_external_config_files(self):
        source = self.source("modern")
        installed = source / "config/lv_conf.h"
        installed.parent.mkdir()
        installed.write_bytes(self.config.read_bytes())
        (installed.parent / "font-options.h").write_bytes((self.config.parent / "font-options.h").read_bytes())
        inspect_source(source, installed, self.sdk, contained=True)
        installed.write_text(f'#include "{self.config}"\n')
        with self.assertRaisesRegex(ValueError, "outside the NDK/SDK"):
            inspect_source(source, installed, self.sdk, contained=True)

    def test_cli_read_only_paths_and_unsupported_major(self):
        source = self.source("legacy")
        result = subprocess.run([sys.executable, "-B", str(ROOT / "toolchains/lvw.py"),
                                 "inspect-lvgl", "--project", str(self.root), "--source", "legacy",
                                 "--config", "config/lv_conf.h", "--sdk", str(self.sdk), "--json"],
                                cwd="/", text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report["ok"])
        self.assertEqual(set(report["tools"]), {"wasi-sdk"})
        self.assertFalse((self.root / "target").exists())
        header = source / "lvgl.h"
        header.write_text(header.read_text().replace("(8 + 1)", "8"))
        with self.assertRaisesRegex(ValueError, "outside the v9\\+"):
            inspect_source(source, self.config, self.sdk)
        header.write_text(header.read_text().replace("LVGL_VERSION_MAJOR 8", "LVGL_VERSION_MAJOR 10"))
        report = inspect_source(source, self.config, self.sdk)
        self.assertEqual(report["version"]["major"], 10)
        self.assertEqual(report["build_verification"], "not-run")


if __name__ == "__main__":
    unittest.main()
