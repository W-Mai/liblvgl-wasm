"""Check the installed NDK's relocation and C/C++/Zig ABI contracts."""

import json
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run(*command):
    subprocess.run([str(item) for item in command], check=True, stdout=sys.stderr)


def verify_runtime_notices(data, report):
    runtime = data / "licenses/runtime"
    manifest_path = runtime / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    assert manifest["schema_version"] == 2
    expected = manifest["files"]
    actual = {}
    for path in runtime.rglob("*"):
        if path.is_file() and path.name != "manifest.json":
            relative = path.relative_to(runtime).as_posix()
            actual[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    assert actual == expected
    for required in (
        "README.md",
        "wasi-libc/LICENSE-APACHE-LLVM",
        "wasi-libc/musl-COPYRIGHT",
        "llvm/source-notices.json",
        "lvgl/LICENCE.txt",
    ):
        assert required in actual and actual[required]
    source = Path(report["source"])
    version = report["version"]
    assert manifest["lvgl"]["version"] == ".".join(str(version[part]) for part in ("major", "minor", "patch"))
    for name, expected in manifest["lvgl"]["files"].items():
        assert (source / name).read_bytes() == (runtime / "lvgl" / name).read_bytes()
        assert expected == actual["lvgl/" + name]
    assert (runtime / "lvgl/COPYRIGHTS.md").exists() == (source / "COPYRIGHTS.md").exists()
    for supplement in manifest["lvgl"]["font_supplements"]:
        pinned = json.loads((ROOT / "third_party/runtime/manifest.json").read_text())
        assert supplement["origin"] == pinned["lvgl"]["url"]
        for name, expected in supplement["inputs"].items():
            assert hashlib.sha256((source / name).read_bytes()).hexdigest() == expected
        original = ROOT / "third_party/runtime/lvgl" / supplement["origin_path"]
        assert original.read_bytes() == (runtime / supplement["path"]).read_bytes()
    for name in ("freetype", "thorvg"):
        component = data / "licenses" / name
        assert component.exists() == (name in manifest["components"])
        if component.exists():
            actual_component = {path.relative_to(component).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                                for path in component.rglob("*") if path.is_file()}
            assert actual_component == manifest["components"][name]["files"]


def layout_checks(api):
    lines = ['#include <stddef.h>', '#include "lvgl/lvgl.h"', '#include "lvw.h"',
             '#ifdef __cplusplus', '#define CHECK static_assert', '#define ALIGN alignof',
             '#else', '#define CHECK _Static_assert', '#define ALIGN _Alignof', '#endif']
    count = 0
    for node in api["types"].values():
        if (node["kind"] != "alias" or not node.get("origin_file", "").startswith("lvgl/")
                or node["layout"]["status"] != "complete"):
            continue
        name, layout = node["name"], node["layout"]
        lines += [f'CHECK(sizeof({name}) == {layout["size"]}, "{name} size");',
                  f'CHECK(ALIGN({name}) == {layout["alignment"]}, "{name} alignment");']
        count += 1
        record = node
        while record["kind"] == "alias":
            record = api["types"][record["underlying"]["id"]]
        if record["kind"] == "record":
            for field in record["fields"]:
                if field["name"] and field["bit_width"] is None:
                    lines.append(f'CHECK(offsetof({name}, {field["name"]}) * 8 == '
                                 f'{field["bit_offset"]}, "{name}.{field["name"]} offset");')
    return "\n".join(lines) + "\n", count


def zig_checks(api):
    # Check native value types; bitfields and types containing them are not Zig values.
    names = {"lv_color_t", "lv_color32_t", "lv_point_t", "lv_point_precise_t",
             "lv_area_t", "lv_matrix_t", "lv_grad_stop_t"}
    names &= {node.get("name") for node in api["types"].values()
              if node["kind"] == "alias" and node["layout"]["status"] == "complete"}
    matrix = "lv_matrix_t" in names
    lines = ["const checked_layouts = blk: {", "    @setEvalBranchQuota(10000);",
             "    var count: u32 = 0;"]
    for node in api["types"].values():
        if node["kind"] != "alias" or node["name"] not in names:
            continue
        name, layout = node["name"], node["layout"]
        assert layout["status"] == "complete"
        names.remove(name)
        lines += [f'    if (@typeInfo(lv.{name}) != .@"opaque") {{',
                  f'        if (@sizeOf(lv.{name}) != {layout["size"]} or '
                  f'@alignOf(lv.{name}) != {layout["alignment"]}) @compileError("{name} layout");']
        record = node
        while record["kind"] == "alias":
            record = api["types"][record["underlying"]["id"]]
        if record["kind"] == "record":
            for field in record["fields"]:
                if field["name"] and field["bit_width"] is None:
                    lines.append(f'        if (@typeInfo(lv.{name}) == .@"struct") {{ '
                                 f'if (@offsetOf(lv.{name}, "{field["name"]}") * 8 != '
                                 f'{field["bit_offset"]}) @compileError("{name}.{field["name"]} offset"); }}')
        lines += ["        count += 1;", "    }"]
    assert not names, names
    for name in ("LV_EVENT_CLICKED", "LV_PART_MAIN", "LV_PALETTE_BLUE", "LV_COLOR_FORMAT_ARGB8888"):
        constant = next(item for item in api["constants"] if item["name"] == name)
        lines.append(f'    if (lv.{name} != {constant["value"]}) @compileError("{name} value");')
    lines += ["    break :blk count;", "};", '''
export fn zig_abi_layouts() u32 { return checked_layouts; }
extern fn ndk_eh_test() c_int;
export fn zig_abi_eh() c_int { return ndk_eh_test(); }
export fn zig_abi_wide(value: i64) i64 { return lv.lv_pow(value, 1); }
export fn zig_abi_color(value: u32) u32 { return lv.lv_color_to_int(lv.lv_color_hex(value)); }
''']
    if matrix:
        lines.append('''export fn zig_abi_float(value: f32) f32 {
    var matrix: lv.lv_matrix_t = undefined;
    lv.lv_matrix_identity(&matrix);
    lv.lv_matrix_translate(&matrix, value, 0.25);
    return matrix.m[0][2];
}
''')
    return "\n".join(lines)


def check(output, build=None):
    build = build or ROOT / "target/wasm"
    sdk = subprocess.check_output(["sh", str(ROOT / "scripts/resolve-wasi-sdk.sh"), str(ROOT)],
                                  text=True).strip()
    run("cmake", "--build", build, "--target", "lvw_ndk", "-j", "4")
    with tempfile.TemporaryDirectory(prefix="lvw ndk contract ") as temporary:
        base = Path(temporary).resolve()
        package = base / "original package"
        run("cmake", "--install", build, "--prefix", package, "--component", "ndk")
        for path in package.rglob("*.cmake"):
            text = path.read_text()
            assert str(ROOT) not in text and sdk not in text, path
        data = package / "share/liblvgl-wasm"
        source_report = json.loads((build / "lvgl-source.json").read_text())
        api = json.loads((data / "metadata/api.json").read_text())
        matrix = any(node.get("name") == "lv_matrix_t" and node["layout"]["status"] == "complete"
                     for node in api["types"].values())
        freetype = any(node.get("name") == "lv_freetype_font_create" for node in api["declarations"])
        header, layouts = layout_checks(api)
        project = base / "original project"
        project.mkdir()
        (project / "layout.h").write_text(header)
        example = (package / "examples/c/direct_api.c").read_text()
        example += '''
static int animation_deletions;
static void animation_deleted(lv_anim_t * animation) {
    (void)animation;
    animation_deletions++;
}
__attribute__((export_name("ndk_animation_deleted"))) int ndk_animation_deleted(int clear_all) {
    lv_anim_t animation;
    lv_anim_init(&animation);
    lv_anim_set_var(&animation, &animation_deletions);
    lv_anim_set_early_apply(&animation, false);
    lv_anim_set_deleted_cb(&animation, animation_deleted);
    animation_deletions = 0;
    if (!lv_anim_start(&animation)) return -1;
    if (clear_all) lv_anim_delete_all();
    else lv_anim_delete(&animation_deletions, NULL);
    return animation_deletions;
}
#if LV_USE_OBSERVER && LVGL_VERSION_MINOR >= 2 && LVGL_VERSION_MINOR <= 5
static int observer_user_events;
static void observer_user_event(lv_event_t * event) {
    (void)event;
    observer_user_events++;
}
static void observer_unbind_event(lv_event_t * event) {
    lv_subject_t * subject = (lv_subject_t *)lv_event_get_param(event);
    int deinit = *(int *)lv_event_get_user_data(event);
    if (subject && deinit) lv_subject_deinit(subject);
    else lv_obj_remove_from_subject((lv_obj_t *)lv_event_get_target(event), subject);
}
static void observer_widget_set(lv_obj_t * obj, int widget, int value) {
    switch (widget) {
        case 0: lv_slider_set_value(obj, value, LV_ANIM_OFF); break;
        case 1: lv_arc_set_value(obj, value); break;
        case 2: lv_roller_set_selected(obj, value, LV_ANIM_OFF); break;
        case 3: lv_dropdown_set_selected(obj, value); break;
    }
}
__attribute__((export_name("ndk_observer_cleanup"))) int ndk_observer_cleanup(int deinit, int widget) {
    lv_display_t * display = lv_display_create(16, 16);
    if (!display) return -1;
    lv_obj_t * screen = lv_display_get_screen_active(display);
    lv_subject_t first, second;
    lv_subject_init_int(&first, 0);
    lv_subject_init_int(&second, 0);
    lv_obj_t * obj = NULL;
    switch (widget) {
        case 0:
            obj = lv_slider_create(screen);
            lv_slider_bind_value(obj, &first);
            lv_slider_bind_value(obj, &second);
            break;
        case 1:
            obj = lv_arc_create(screen);
            lv_arc_bind_value(obj, &first);
            lv_arc_bind_value(obj, &second);
            break;
        case 2:
            obj = lv_roller_create(screen);
            lv_roller_set_options(obj, "0\\n1\\n2", LV_ROLLER_MODE_NORMAL);
            lv_roller_bind_value(obj, &first);
            lv_roller_bind_value(obj, &second);
            break;
        case 3:
            obj = lv_dropdown_create(screen);
            lv_dropdown_set_options(obj, "0\\n1\\n2");
            lv_dropdown_bind_value(obj, &first);
            lv_dropdown_bind_value(obj, &second);
            break;
        default: lv_display_delete(display); return -4;
    }
    lv_obj_add_event_cb(obj, observer_user_event, LV_EVENT_VALUE_CHANGED, NULL);
    lv_obj_add_event_cb(obj, observer_user_event, LV_EVENT_VALUE_CHANGED, &first);
    lv_obj_add_event_cb(obj, observer_unbind_event, LV_EVENT_CLICKED, &deinit);
    observer_user_events = 0;
    lv_obj_send_event(obj, LV_EVENT_CLICKED, &first);
    observer_widget_set(obj, widget, 1);
    lv_obj_send_event(obj, LV_EVENT_VALUE_CHANGED, NULL);
    int result = lv_subject_get_int(&first) == 0 && lv_subject_get_int(&second) == 1 &&
                 observer_user_events == 2 ? 0 : -2;
    lv_obj_send_event(obj, LV_EVENT_CLICKED, NULL);
    observer_widget_set(obj, widget, 2);
    lv_obj_send_event(obj, LV_EVENT_VALUE_CHANGED, NULL);
    if (lv_subject_get_int(&second) != 1 || observer_user_events != 4) result = -3;
    lv_display_delete(display);
    lv_subject_deinit(&first);
    lv_subject_deinit(&second);
    return result;
}
#endif
#if LV_USE_OBSERVER && LV_USE_EXT_DATA && LVGL_VERSION_MINOR >= 5
static int subject_releases, subject_bad_data, subject_marker;
static void subject_data_release(void * data) {
    subject_releases++;
    if (data != &subject_marker) subject_bad_data++;
}
static void subject_data_observer(lv_observer_t * observer, lv_subject_t * subject) {
    (void)subject;
    (*(int *)lv_observer_get_user_data(observer))++;
}
static void subject_remove_observer(lv_observer_t * observer) {
#if LVGL_VERSION_MINOR < 6
    lv_observer_remove(observer);
#else
    lv_observer_delete(observer);
#endif
}
__attribute__((export_name("ndk_subject_external_data"))) int ndk_subject_external_data(void) {
    int calls = 0, result = 0;
    subject_releases = subject_bad_data = 0;
#if LVGL_VERSION_MINOR < 6
    lv_subject_t subject_storage, empty_storage;
    lv_subject_t * subject = &subject_storage, * empty = &empty_storage;
    lv_subject_init_int(subject, 0);
    lv_subject_init_int(empty, 0);
#else
    lv_subject_t * subject = lv_subject_create(LV_SUBJECT_TYPE_INT);
    lv_subject_t * empty = lv_subject_create(LV_SUBJECT_TYPE_INT);
    if (!subject || !empty) {
        lv_subject_delete(subject);
        lv_subject_delete(empty);
        return -6;
    }
#endif
    lv_subject_set_external_data(subject, &subject_marker, subject_data_release);
    lv_observer_t * first = lv_subject_add_observer_with_target(subject, subject_data_observer, NULL, &calls);
    lv_observer_t * second = lv_subject_add_observer_with_target(subject, subject_data_observer, NULL, &calls);
    subject_remove_observer(first);
    lv_subject_set_int(subject, 1);
    if (subject_releases != 0 || calls != 3) result = -1;
    lv_display_t * display = lv_display_create(16, 16);
    lv_obj_t * obj = lv_obj_create(lv_display_get_screen_active(display));
    lv_subject_add_observer_obj(subject, subject_data_observer, obj, &calls);
    lv_obj_delete(obj);
    subject_remove_observer(second);
    if (subject_releases != 0 || calls != 4) result = -2;
#if LVGL_VERSION_MINOR < 6
    lv_subject_deinit(subject);
#else
    lv_subject_delete(subject);
#endif
    if (subject_releases != 1) result = -3;
#if LVGL_VERSION_MINOR == 5
    lv_subject_deinit(subject);
    if (subject_releases != 1) result = -4;
#endif
    lv_subject_set_external_data(empty, &subject_marker, subject_data_release);
#if LVGL_VERSION_MINOR < 6
    lv_subject_deinit(empty);
#else
    lv_subject_delete(empty);
#endif
    if (subject_releases != 2 || subject_bad_data != 0) result = -5;
    lv_display_delete(display);
    return result;
}
#endif
'''
        png = (ROOT / "tests/fixtures/png/rgba.png").read_bytes()
        example += '''
#if LV_USE_LODEPNG && (LVGL_VERSION_MINOR == 0 || LVGL_VERSION_MINOR == 1)
static int png_failed_source(const lv_image_decoder_dsc_t * dsc, const void * source) {
#if LVGL_VERSION_MINOR == 0
    (void)source;
    return dsc->src == NULL;
#else
    return dsc->src == source;
#endif
}
__attribute__((export_name("ndk_png_cleanup"))) int ndk_png_cleanup(void) {
    static const uint8_t png[] = {PNG_BYTES};
    static const char bad[] = "ndk-png-short.png", good[] = "ndk-png-good.png";
    if (lvw_resource_put((uint32_t)(uintptr_t)bad, sizeof(bad) - 1,
                         (uint32_t)(uintptr_t)png, 33) != 0) return -1;
    if (lvw_resource_put((uint32_t)(uintptr_t)good, sizeof(good) - 1,
                         (uint32_t)(uintptr_t)png, sizeof(png)) != 0) return -2;
    lv_image_decoder_dsc_t dsc;
    const char * bad_path = "W:ndk-png-short.png", * good_path = "W:ndk-png-good.png";
    if (lv_image_decoder_open(&dsc, bad_path, NULL) != LV_RESULT_INVALID) return -3;
    if (!png_failed_source(&dsc, bad_path) || dsc.decoded != NULL) return -4;
    char * borrowed = lv_strdup(good_path);
    if (borrowed == NULL) return -9;
    if (lv_image_decoder_open(&dsc, borrowed, NULL) != LV_RESULT_OK) return -5;
#if LVGL_VERSION_MINOR == 1
    if (dsc.src != borrowed) return -10;
#endif
#if LV_CACHE_DEF_SIZE > 0
    lv_cache_t * cache = dsc.cache;
    const void * entry = dsc.cache_entry;
    const void * decoded = dsc.decoded;
#endif
    lv_image_decoder_close(&dsc);
    lv_memset(borrowed, 'x', lv_strlen(borrowed));
    lv_free(borrowed);
#if LV_CACHE_DEF_SIZE > 0
    lv_image_decoder_dsc_t cached;
    if (lv_image_decoder_open(&cached, good_path, NULL) != LV_RESULT_OK) return -6;
    if (cached.cache_entry == NULL || cached.cache_entry != entry || cached.decoded != decoded) return -7;
    lv_image_decoder_close(&cached);
#endif
    lv_image_cache_drop(good_path);
#if LV_CACHE_DEF_SIZE > 0
    lv_cache_set_max_size(cache, 1, NULL);
    lv_result_t result = lv_image_decoder_open(&dsc, good_path, NULL);
    int failed = result != LV_RESULT_INVALID || !png_failed_source(&dsc, good_path) || dsc.decoded != NULL;
    if (result == LV_RESULT_OK) lv_image_decoder_close(&dsc);
    lv_cache_set_max_size(cache, LV_CACHE_DEF_SIZE, NULL);
    if (failed) return -8;
#endif
    return 0;
}
#endif
'''.replace("PNG_BYTES", ",".join(map(str, png)))
        gif = (ROOT / "tests/fixtures/gif/single-pass.gif").read_bytes()
        example += '''
#if LV_USE_GIF && (LVGL_VERSION_MINOR == 0 || LVGL_VERSION_MINOR == 1)
static int gif_ready, gif_ticks;
static lv_timer_t * gif_replacement_timer;
static void gif_tick(lv_timer_t * timer) { (void)timer; gif_ticks++; }
static void gif_finished(lv_event_t * event) {
    gif_ready++;
    lv_obj_delete((lv_obj_t *)lv_event_get_target(event));
    gif_replacement_timer = lv_timer_create(gif_tick, 1, NULL);
}
__attribute__((export_name("ndk_gif_lifecycle"))) int ndk_gif_lifecycle(lv_obj_t * parent) {
    static const uint8_t data[] = {GIF_BYTES};
    lv_image_dsc_t source;
    lv_memzero(&source, sizeof(source));
    source.header.cf = LV_COLOR_FORMAT_RAW_ALPHA;
    source.data = data;
    source.data_size = sizeof(data);
    lv_obj_t * object = lv_gif_create(parent);
    lv_gif_t * gif = (lv_gif_t *)object;
    lv_gif_set_src(object, &source);
    if (!gif->gif || gif->imgdsc.header.w != 9 || gif->imgdsc.header.h != 7 ||
        gif->imgdsc.header.stride != 36 || gif->timer->period != 80) return -1;
    lv_gif_pause(object);
    if (!gif->timer->paused) return -2;
    lv_gif_resume(object);
    if (gif->timer->paused) return -3;
    lv_gif_set_src(object, NULL);
    if (gif->gif || !gif->timer->paused || lv_image_get_src(object)) return -4;
    lv_gif_set_src(object, &source);
    gif_ready = gif_ticks = 0;
    lv_obj_add_event_cb(object, gif_finished, LV_EVENT_READY, NULL);
    lv_tick_inc(80); lv_timer_handler();
    lv_tick_inc(120); lv_timer_handler();
    if (gif_ready != 0) return -5;
    lv_tick_inc(160); lv_timer_handler();
    if (gif_ready != 1) return -6;
    lv_tick_inc(1); lv_timer_handler();
    lv_tick_inc(1); lv_timer_handler();
    if (gif_ticks != 2) return -7;
    lv_timer_delete(gif_replacement_timer);
    return 0;
}
#endif
'''.replace("GIF_BYTES", ",".join(map(str, gif)))
        font = (ROOT / "tests/fixtures/tinyttf/geometry.ttf").read_bytes()
        fallback_font = (ROOT / "tests/fixtures/tinyttf/fallback.ttf").read_bytes()
        example += r'''
#if LV_USE_TINY_TTF && LVGL_VERSION_MINOR == 0
__attribute__((export_name("ndk_tinyttf_lifetimes"))) int ndk_tinyttf_lifetimes(lv_obj_t * parent) {
    static const uint8_t data[] = {TTF_BYTES};
    static const uint8_t fallback_data[] = {FALLBACK_BYTES};
    lv_font_t * first = lv_tiny_ttf_create_data_ex(data, sizeof(data), 16, 0);
    lv_font_t * second = lv_tiny_ttf_create_data_ex(data, sizeof(data), 24, 1);
    if (!first || !second) return -1;
    lv_font_glyph_dsc_t glyph;
    lv_memzero(&glyph, sizeof(glyph));
    if (!lv_font_get_glyph_dsc(first, &glyph, 'A', 0) ||
        !lv_font_get_glyph_bitmap(&glyph, 'A', NULL)) return -2;
    first->release_glyph(first, &glyph);
    if (!lv_font_get_glyph_dsc(second, &glyph, 'B', 0) ||
        !lv_font_get_glyph_bitmap(&glyph, 'B', NULL)) return -3;
    lv_cache_t * cache = (lv_cache_t *)lv_cache_entry_get_cache(glyph.entry);
    if (lv_cache_get_max_size(cache, NULL) != 128 || lv_cache_get_size(cache, NULL) != 2) return -4;
    lv_tiny_ttf_set_size(first, 32);
    if (lv_cache_get_size(cache, NULL) != 1) return -5;
    lv_tiny_ttf_destroy(first);
    if (lv_cache_get_size(cache, NULL) != 1 || lv_cache_entry_get_ref(glyph.entry) != 1) return -6;
    second->release_glyph(second, &glyph);
    if (glyph.entry != NULL) return -7;
    lv_tiny_ttf_destroy(second);
    if (lv_cache_get_size(cache, NULL) != 0) return -8;
    lv_font_t * fallback = lv_tiny_ttf_create_data(fallback_data, sizeof(fallback_data), 16);
    if (!fallback) return -9;
    lv_font_t primary = *LV_FONT_DEFAULT;
    if (primary.release_glyph != NULL) return -10;
    primary.fallback = fallback;
    lv_obj_t * label = lv_label_create(parent);
    lv_obj_set_style_text_font(label, &primary, 0);
    lv_label_set_text(label, "\xCE\xA9");
    lv_obj_update_layout(parent);
    lv_refr_now(NULL);
    if (!lv_font_get_glyph_dsc(&primary, &glyph, 937, 0) || glyph.resolved_font != fallback ||
        !lv_font_get_glyph_bitmap(&glyph, 937, NULL)) return -11;
    if (lv_cache_entry_get_ref(glyph.entry) != 1) return -12;
    fallback->release_glyph(fallback, &glyph);
    lv_obj_delete(label);
    lv_tiny_ttf_destroy(fallback);
    return lv_cache_get_size(cache, NULL) == 0 ? 0 : -13;
}
#endif
'''.replace("TTF_BYTES", ",".join(map(str, font))).replace("FALLBACK_BYTES", ",".join(map(str, fallback_font)))
        ft_fixture = json.loads((ROOT / "tests/fixtures/freetype/expected.json").read_text())
        ft_font = (ROOT / "tests/fixtures/freetype" / ft_fixture["font"]["file"]).read_bytes()
        ft_fallback = (ROOT / "tests/fixtures/freetype" / ft_fixture["fallback"]["file"]).read_bytes()
        example += r'''
#if LV_USE_FREETYPE
static const void * ndk_ft_bitmap(lv_font_glyph_dsc_t * glyph, uint32_t letter) {
#if LVGL_VERSION_MINOR == 0
    return lv_font_get_glyph_bitmap(glyph, letter, NULL);
#else
    (void)letter;
    return lv_font_get_glyph_bitmap(glyph, NULL);
#endif
}
static void ndk_ft_release(lv_font_glyph_dsc_t * glyph) {
#if LVGL_VERSION_MINOR == 0
    glyph->resolved_font->release_glyph(glyph->resolved_font, glyph);
#else
    lv_font_glyph_release_draw_data(glyph);
#endif
}
__attribute__((export_name("ndk_freetype_lifetimes"))) int ndk_freetype_lifetimes(lv_obj_t * parent) {
    static const uint8_t bytes[] = {FT_BYTES}, fallback_bytes[] = {FT_FALLBACK};
    static const char name[] = "ndk-ft.ttf", fallback_name[] = "ndk-ft-fallback.ttf";
    if (lvw_resource_put((uint32_t)(uintptr_t)name, sizeof(name) - 1,
                         (uint32_t)(uintptr_t)bytes, sizeof(bytes))) return -1;
    if (lvw_resource_put((uint32_t)(uintptr_t)fallback_name, sizeof(fallback_name) - 1,
                         (uint32_t)(uintptr_t)fallback_bytes, sizeof(fallback_bytes))) return -2;
    char path[] = "W:ndk-ft.ttf";
    lv_font_t * small = lv_freetype_font_create(path, LV_FREETYPE_FONT_RENDER_MODE_BITMAP, 16, LV_FREETYPE_FONT_STYLE_NORMAL);
    lv_font_t * peer = lv_freetype_font_create(path, LV_FREETYPE_FONT_RENDER_MODE_BITMAP, 16, LV_FREETYPE_FONT_STYLE_NORMAL);
    lv_font_t * large = lv_freetype_font_create(path, LV_FREETYPE_FONT_RENDER_MODE_BITMAP, 32, LV_FREETYPE_FONT_STYLE_NORMAL);
    if (!small || !peer || !large) return -3;
    lv_memset(path, 'X', sizeof(path) - 1);
    lv_font_glyph_dsc_t first, second;
    lv_memzero(&first, sizeof(first));
    lv_memzero(&second, sizeof(second));
    if (!lv_font_get_glyph_dsc(small, &first, 'A', 0) || !ndk_ft_bitmap(&first, 'A')) return -4;
    if (!lv_font_get_glyph_dsc(large, &second, 'B', 0) || !ndk_ft_bitmap(&second, 'B')) return -5;
    lv_freetype_font_delete(peer);
#if LVGL_VERSION_MINOR == 0
    if (lv_cache_entry_get_ref(first.entry) != 1 || lv_cache_entry_get_ref(second.entry) != 1) return -6;
#endif
    ndk_ft_release(&first);
    if (first.entry != NULL) return -7;
    lv_freetype_font_delete(small);
#if LVGL_VERSION_MINOR == 0
    if (lv_cache_entry_get_ref(second.entry) != 1) return -8;
#endif
    ndk_ft_release(&second);
    if (second.entry != NULL) return -9;
    lv_freetype_font_delete(large);
    lv_font_t * fallback = lv_freetype_font_create("W:ndk-ft-fallback.ttf", LV_FREETYPE_FONT_RENDER_MODE_BITMAP,
                                                  16, LV_FREETYPE_FONT_STYLE_NORMAL);
    if (!fallback) return -10;
    lv_font_t primary = *LV_FONT_DEFAULT;
    primary.fallback = fallback;
    lv_obj_t * label = lv_label_create(parent);
    lv_obj_set_style_text_font(label, &primary, 0);
    lv_label_set_text(label, "\xCE\xA9");
    lv_obj_update_layout(parent);
    lv_refr_now(NULL);
    if (!lv_font_get_glyph_dsc(&primary, &first, 937, 0) || first.resolved_font != fallback ||
        !ndk_ft_bitmap(&first, 937)) return -11;
#if LVGL_VERSION_MINOR == 0
    if (lv_cache_entry_get_ref(first.entry) != 1) return -12;
#endif
    ndk_ft_release(&first);
    lv_obj_delete(label);
    lv_freetype_font_delete(fallback);
    return 0;
}
#endif
'''.replace("FT_BYTES", ",".join(map(str, ft_font))).replace("FT_FALLBACK", ",".join(map(str, ft_fallback)))
        example += r'''
#if LV_USE_THORVG_INTERNAL && LVGL_VERSION_MINOR == 0
#include "lvgl/src/libs/thorvg/thorvg_capi.h"
__attribute__((export_name("ndk_thorvg_resources"))) int ndk_thorvg_resources(void) {
    static const char name[] = "ndk-vector.svg";
    static const char svg[] = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\">"
        "<rect x=\"2\" y=\"1\" width=\"3\" height=\"4\" fill=\"#123456\"/></svg>";
    if (lvw_resource_put((uint32_t)(uintptr_t)name, sizeof(name) - 1,
                         (uint32_t)(uintptr_t)svg, sizeof(svg) - 1) != 0) return -1;
    Tvg_Paint * missing = tvg_picture_new();
    if (tvg_picture_load(missing, "W:absent.svg") == TVG_RESULT_SUCCESS) return -2;
    tvg_paint_del(missing);
    Tvg_Canvas * canvases[2];
    uint32_t pixels[2][64];
    for (int i = 0; i < 2; i++) {
        for (int p = 0; p < 64; p++) pixels[i][p] = 0xff202830;
        canvases[i] = tvg_swcanvas_create();
        if (!canvases[i]) return -3;
        if (tvg_swcanvas_set_target(canvases[i], pixels[i], 8, 8, 8, TVG_COLORSPACE_ARGB8888)
            != TVG_RESULT_SUCCESS) return -4;
        Tvg_Paint * picture = tvg_picture_new();
        char path[] = "W:ndk-vector.svg";
        if (tvg_picture_load(picture, path) != TVG_RESULT_SUCCESS) return -5;
        lv_memzero(path, sizeof(path));
        if (tvg_canvas_push(canvases[i], picture) != TVG_RESULT_SUCCESS) return -6;
    }
    for (int i = 0; i < 2; i++) {
        if (tvg_canvas_draw(canvases[i]) != TVG_RESULT_SUCCESS ||
            tvg_canvas_sync(canvases[i]) != TVG_RESULT_SUCCESS) return -7;
        for (int y = 0; y < 8; y++) {
            for (int x = 0; x < 8; x++) {
                uint32_t expected = x >= 2 && x < 5 && y >= 1 && y < 5 ? 0xff123456 : 0xff202830;
                if (pixels[i][y * 8 + x] != expected) return -8;
            }
        }
        if (tvg_canvas_destroy(canvases[i]) != TVG_RESULT_SUCCESS) return -9;
    }
    return 0;
}
#endif
'''
        (project / "main.c").write_text('#include "layout.h"\n' + example)
        (project / "main.cpp").write_text('#include "layout.h"\n' + example)
        (project / "eh.cpp").write_text('''#include "lvw.h"
#include <setjmp.h>
#include <string>
static jmp_buf jump;
extern "C" __attribute__((export_name("ndk_eh_test"))) int ndk_eh_test() {
    if (setjmp(jump) == 0) longjmp(jump, 7);
    try { throw std::string("standard EH"); }
    catch (const std::string &value) { return value == "standard EH" && lvw_abi_version() == 1 ? 42 : -1; }
}
''')
        (project / "main.zig").write_text((package / "examples/zig/direct_api.zig").read_text()
                                         + "\n" + zig_checks(api))
        (project / "CMakeLists.txt").write_text('''cmake_minimum_required(VERSION 3.25)
project(ndk_contract LANGUAGES C CXX)
find_package(liblvgl-wasm CONFIG REQUIRED)
lvw_add_reactor(consumer_c main.c)
lvw_add_reactor(consumer_cpp main.cpp)
lvw_add_zig_reactor(consumer_zig main.zig)
target_sources(consumer_cpp PRIVATE eh.cpp)
target_sources(consumer_zig PRIVATE eh.cpp)
target_link_options(consumer_zig PRIVATE -Wl,--export=lvw_demo_create
    -Wl,--export=zig_abi_layouts -Wl,--export=zig_abi_wide
    -Wl,--export=zig_abi_color -Wl,--export=zig_abi_eh)
target_compile_options(consumer_c PRIVATE -Wall -Wextra -Werror)
target_compile_options(consumer_cpp PRIVATE -Wall -Wextra -Werror)
''')
        if matrix:
            with (project / "CMakeLists.txt").open("a") as file:
                file.write("target_link_options(consumer_zig PRIVATE -Wl,--export=zig_abi_float)\n")
        zig = os.environ.get("LVW_ZIG") or shutil.which("zig")
        if not zig:
            candidates = list((ROOT / "target/toolchains/tools").glob("zig-0.15.2-*/zig"))
            if len(candidates) != 1:
                raise ValueError("run toolchains/lvw.py prepare --with-zig, or set LVW_ZIG")
            zig = str(candidates[0])
        run(zig, "fmt", "--check", package / "examples/zig/direct_api.zig")

        def build():
            run("cmake", "-S", project, "-B", project / "target", "-G", "Ninja",
                f"-DCMAKE_TOOLCHAIN_FILE={sdk}/share/cmake/wasi-sdk-p1.cmake",
                f"-Dliblvgl-wasm_DIR={package}/lib/cmake/liblvgl-wasm", "-DCMAKE_BUILD_TYPE=Release",
                f"-DLVW_ZIG={zig}")
            run("cmake", "--build", project / "target", "-j", "2")

        build()
        shutil.rmtree(project / "target")
        package = package.rename(base / "moved package")
        project = project.rename(base / "moved project")
        for path in [*package.rglob("*"), package]:
            path.chmod(0o555 if path.is_dir() else 0o444)
        try:
            build()
            data = package / "share/liblvgl-wasm"
            verify_runtime_notices(data, source_report)
            for language in ("c", "cpp", "zig"):
                core = output / f"{language}.wasm"
                shutil.copyfile(project / f"target/consumer_{language}.wasm", core)
                run("wasm-tools", "validate", core)
                proof = output / f"{language}-verification.json"
                run(sys.executable, "-B", data / "generator/signatures.py", "--api",
                    data / "metadata/api.json", "--wasm", core, "--output", proof)
                generated = output / language / "target/typescript"
                generated.mkdir(parents=True)
                for generator, file in (("values", "values.ts"), ("typescript", "raw.ts"),
                                        ("rust", "raw.rs")):
                    run(sys.executable, "-B", data / f"generator/{generator}.py", "--api",
                        data / "metadata/api.json", "--wasm", core, "--verification", proof,
                        "--output", generated / file)
                # Host SDK packaging is separate; exercise the existing host with this core's bindings.
                shutil.copytree(ROOT / "bindings/typescript/src", output / language / "bindings/typescript/src")
                os.symlink(ROOT / "node_modules", output / language / "node_modules", target_is_directory=True)
            (output / "report.json").write_text(json.dumps({"layouts": layouts, "relocated": True,
                                                           "matrix": matrix, "freetype": freetype,
                                                           "readonly_package": True}) + "\n")
        finally:
            for path in [package, *package.rglob("*")]:
                path.chmod(0o755 if path.is_dir() else 0o644)


if __name__ == "__main__":
    check(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None)
