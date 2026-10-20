use std::path::Path;

use liblvgl_wasm_host::{Result, Runtime, UnsafePointer, values};
use serde_json::Value;

fn expected() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/tinyttf/expected.json"
    ))
    .unwrap()
}

fn number(value: &Value) -> i32 {
    value.as_i64().unwrap() as i32
}

fn offset(fields: &[values::FieldLayout], name: &str) -> u32 {
    let field = fields
        .iter()
        .find(|field| field.name == Some(name))
        .unwrap();
    assert!(field.bit_width.is_none());
    assert_eq!(field.bit_offset % 8, 0);
    (field.bit_offset / 8) as u32
}

fn read_u32(runtime: &Runtime, pointer: u32) -> Result<u32> {
    let mut bytes = [0; 4];
    runtime.read_memory(pointer, &mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn color(runtime: &mut Runtime, rgb: &Value) -> Result<UnsafePointer> {
    let mut raw = runtime.raw()?;
    let pointer = raw.alloc(values::LV_COLOR_T_SIZE)?;
    raw.lv_color_hex(
        pointer,
        (number(&rgb[0]) << 16) | (number(&rgb[1]) << 8) | number(&rgb[2]),
    )?;
    Ok(pointer)
}

fn load(expected: &Value) -> Result<(Runtime, u32, UnsafePointer)> {
    let mut runtime = Runtime::from_file(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm/liblvgl.wasm"),
    )?;
    let display = runtime.call_raw("lvw_display_create", (160u32, 96u32, 1u32))?;
    let screen = runtime
        .raw()?
        .lv_display_get_screen_active(UnsafePointer(display))?;
    let color = color(&mut runtime, &expected["background"])?;
    runtime
        .raw()?
        .lv_obj_set_style_bg_color(screen, color, values::LV_PART_MAIN)?;
    runtime
        .raw()?
        .lv_obj_set_style_bg_opa(screen, values::LV_OPA_COVER, values::LV_PART_MAIN)?;
    runtime.free(color.0)?;
    Ok((runtime, display, screen))
}

fn data(runtime: &mut Runtime, fixture: &Value) -> Result<(UnsafePointer, i32)> {
    let bytes = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/tinyttf")
            .join(fixture["file"].as_str().unwrap()),
    )?;
    let pointer = runtime.alloc(bytes.len() as u32)?;
    runtime.write_memory(pointer, &bytes)?;
    // Native TinyTTF borrows these bytes until all fonts using them are destroyed.
    Ok((UnsafePointer(pointer), bytes.len() as i32))
}

fn create_font(
    runtime: &mut Runtime,
    data: (UnsafePointer, i32),
    size: &Value,
    cache: Option<i32>,
) -> Result<UnsafePointer> {
    let pointer = if let Some(cache) = cache {
        runtime.raw()?.lv_tiny_ttf_create_data_ex(
            data.0,
            data.1,
            number(&size["size"]),
            values::LV_FONT_KERNING_NORMAL,
            cache,
        )?
    } else {
        runtime
            .raw()?
            .lv_tiny_ttf_create_data(data.0, data.1, number(&size["size"]))?
    };
    assert_ne!(pointer.0, 0);
    Ok(pointer)
}

fn verify_glyph(
    runtime: &mut Runtime,
    font: UnsafePointer,
    resolved: UnsafePointer,
    expected: &Value,
    size: &Value,
    name: &str,
) -> Result<()> {
    let glyph = &size["glyphs"][name];
    let descriptor = UnsafePointer(runtime.alloc(values::LV_FONT_GLYPH_DSC_T_SIZE)?);
    assert_eq!(
        runtime.raw()?.lv_font_get_glyph_dsc(
            font,
            descriptor,
            number(&expected["codepoints"][name]),
            0
        )?,
        1
    );
    for name in ["advance", "box_w", "box_h", "ofs_x", "ofs_y"] {
        let field = if name == "advance" { "adv_w" } else { name };
        let mut bytes = [0; 2];
        runtime.read_memory(
            descriptor.0 + offset(values::LV_FONT_GLYPH_DSC_T_FIELDS, field),
            &mut bytes,
        )?;
        let actual = if field.starts_with("ofs_") {
            i16::from_le_bytes(bytes) as i32
        } else {
            u16::from_le_bytes(bytes) as i32
        };
        assert_eq!(actual, number(&glyph[name]), "glyph field {field}");
    }
    assert_eq!(
        read_u32(
            runtime,
            descriptor.0 + offset(values::LV_FONT_GLYPH_DSC_T_FIELDS, "resolved_font")
        )?,
        resolved.0
    );
    assert_eq!(values::LV_FONT_GLYPH_FORMAT_T_SIZE, 4);
    assert_eq!(
        read_u32(
            runtime,
            descriptor.0 + offset(values::LV_FONT_GLYPH_DSC_T_FIELDS, "format")
        )?,
        values::LV_FONT_GLYPH_FORMAT_A8 as u32
    );
    assert_eq!(
        runtime
            .raw()?
            .lv_font_get_glyph_width(font, number(&expected["codepoints"][name]), 0)?,
        number(&glyph["advance"])
    );
    let bitmap = runtime
        .raw()?
        .lv_font_get_glyph_bitmap(descriptor, UnsafePointer(0))?;
    assert_ne!(bitmap.0, 0);
    assert_ne!(
        read_u32(
            runtime,
            descriptor.0 + offset(values::LV_FONT_GLYPH_DSC_T_FIELDS, "entry")
        )?,
        0
    );
    for (row, expected_row) in glyph["alpha"].as_array().unwrap().iter().enumerate() {
        let pointer = runtime.raw()?.lv_draw_buf_goto_xy(bitmap, 0, row as i32)?;
        let mut bytes = vec![0; number(&glyph["box_w"]) as usize];
        runtime.read_memory(pointer.0, &mut bytes)?;
        for (column, actual) in bytes.iter().enumerate() {
            let alpha = number(&expected_row[column]);
            let tolerance = i32::from(alpha != 0 && alpha != 255);
            assert!(
                (*actual as i32 - alpha).abs() <= tolerance,
                "glyph {name} bitmap ({column}, {row}): {actual} != {alpha}"
            );
        }
    }
    runtime.raw()?.lv_font_glyph_release_draw_data(descriptor)?;
    assert_eq!(
        read_u32(
            runtime,
            descriptor.0 + offset(values::LV_FONT_GLYPH_DSC_T_FIELDS, "entry")
        )?,
        0
    );
    runtime.free(descriptor.0)
}

fn set_text(
    runtime: &mut Runtime,
    label: UnsafePointer,
    expected: &Value,
    names: &[&str],
) -> Result<()> {
    let mut text: String = names
        .iter()
        .map(|name| char::from_u32(number(&expected["codepoints"][name]) as u32).unwrap())
        .collect();
    text.push('\0');
    let pointer = UnsafePointer(runtime.alloc(text.len() as u32)?);
    runtime.write_memory(pointer.0, text.as_bytes())?;
    runtime.raw()?.lv_label_set_text(label, pointer)?;
    runtime.free(pointer.0)
}

fn label(
    runtime: &mut Runtime,
    screen: UnsafePointer,
    font: UnsafePointer,
    expected: &Value,
    names: &[&str],
    y: i32,
) -> Result<UnsafePointer> {
    let object = runtime.raw()?.lv_label_create(screen)?;
    let color = color(runtime, &expected["foreground"])?;
    {
        let mut raw = runtime.raw()?;
        raw.lv_obj_set_style_text_font(object, font, values::LV_PART_MAIN)?;
        raw.lv_obj_set_style_text_color(object, color, values::LV_PART_MAIN)?;
        raw.lv_obj_set_style_text_opa(object, values::LV_OPA_COVER, values::LV_PART_MAIN)?;
        raw.lv_obj_set_style_text_letter_space(object, 0, values::LV_PART_MAIN)?;
        raw.lv_obj_set_style_text_line_space(object, 0, values::LV_PART_MAIN)?;
        raw.lv_obj_set_style_text_leading_trim(
            object,
            values::LV_TEXT_LEADING_TRIM_NONE,
            values::LV_PART_MAIN,
        )?;
        raw.lv_obj_set_style_text_align(object, values::LV_TEXT_ALIGN_LEFT, values::LV_PART_MAIN)?;
        raw.lv_obj_set_style_text_decor(object, values::LV_TEXT_DECOR_NONE, values::LV_PART_MAIN)?;
        raw.lv_obj_set_style_pad_all(object, 0, values::LV_PART_MAIN)?;
        raw.lv_obj_set_pos(object, 4, y)?;
    }
    runtime.free(color.0)?;
    set_text(runtime, object, expected, names)?;
    Ok(object)
}

fn verify_label(
    runtime: &mut Runtime,
    display: u32,
    label: UnsafePointer,
    expected: &Value,
    size: &Value,
    names: &[&str],
    kerning: bool,
) -> Result<()> {
    let height = number(&size["line_height"]) as usize;
    let mut pen = 0i32;
    let mut placed = Vec::new();
    for (index, name) in names.iter().enumerate() {
        let glyph = &size["glyphs"][name];
        placed.push((pen, glyph));
        pen += number(&glyph["advance"]);
        if kerning && *name == "A" && names.get(index + 1) == Some(&"B") {
            pen -= number(&size["kerning"]);
        }
    }
    let width = pen as usize;
    let mut alpha = vec![0i32; width * height];
    for (pen, glyph) in placed {
        let left = pen + number(&glyph["ofs_x"]);
        let top = number(&size["line_height"])
            - number(&size["baseline"])
            - number(&glyph["box_h"])
            - number(&glyph["ofs_y"]);
        for (row, values) in glyph["alpha"].as_array().unwrap().iter().enumerate() {
            for (column, value) in values.as_array().unwrap().iter().enumerate() {
                alpha[(top as usize + row) * width + left as usize + column] = number(value);
            }
        }
    }
    runtime.raw()?.lv_obj_update_layout(label)?;
    let y = runtime.raw()?.lv_obj_get_y(label)?;
    assert_eq!(runtime.raw()?.lv_obj_get_width(label)?, width as i32);
    assert_eq!(runtime.raw()?.lv_obj_get_height(label)?, height as i32);
    runtime.raw()?.lv_obj_invalidate(label)?;
    runtime.raw()?.lv_refr_now(UnsafePointer(display))?;
    let descriptor = runtime.alloc(48)?;
    let mut header = [0; 48];
    header[..4].copy_from_slice(&48u32.to_le_bytes());
    header[4..8].copy_from_slice(&1u32.to_le_bytes());
    runtime.write_memory(descriptor, &header)?;
    assert_eq!(
        runtime.call_raw::<_, i32>("lvw_frame_get", (display, descriptor))?,
        0
    );
    runtime.read_memory(descriptor, &mut header)?;
    let word = |offset| u32::from_le_bytes(header[offset..offset + 4].try_into().unwrap());
    assert_eq!((word(16), word(20), word(28)), (160, 96, 1));
    let mut pixels = vec![0; word(12) as usize];
    runtime.read_memory(word(8), &mut pixels)?;
    runtime.free(descriptor)?;
    for row in -1..=height as i32 {
        for column in -1..=width as i32 {
            let coverage =
                if row < 0 || column < 0 || row == height as i32 || column == width as i32 {
                    0
                } else {
                    alpha[row as usize * width + column as usize]
                };
            let position = ((y + row) as usize * word(24) as usize) + (4 + column) as usize * 4;
            for channel in 0..3 {
                let foreground = number(&expected["foreground"][channel]);
                let background = number(&expected["background"][channel]);
                let reference = (foreground * coverage + background * (255 - coverage)) / 255;
                let actual = pixels[position + 2 - channel] as i32;
                let tolerance = if coverage == 0 || coverage == 255 {
                    0
                } else {
                    2
                };
                assert!(
                    (actual - reference).abs() <= tolerance,
                    "label ({column}, {row}), channel {channel}: {actual} != {reference}, coverage {coverage}"
                );
            }
        }
    }
    Ok(())
}

#[test]
fn tinyttf_metrics_bitmaps_kerning_and_labels_match_geometric_reference() -> Result<()> {
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    let data = data(&mut runtime, &expected["font"])?;
    for size in expected["sizes"].as_array().unwrap() {
        let font = create_font(&mut runtime, data, size, None)?;
        assert_eq!(
            runtime.raw()?.lv_font_get_line_height(font)?,
            number(&size["line_height"])
        );
        assert_eq!(
            read_u32(
                &runtime,
                font.0 + offset(values::LV_FONT_T_FIELDS, "base_line")
            )? as i32,
            number(&size["baseline"])
        );
        for name in ["space", "A", "B", "Aacute"] {
            verify_glyph(&mut runtime, font, font, &expected, size, name)?;
        }
        let left = number(&expected["kerning"]["left"]);
        let right = number(&expected["kerning"]["right"]);
        assert_eq!(
            runtime.raw()?.lv_font_get_glyph_width(font, left, right)?,
            number(&size["glyphs"]["A"]["advance"]) - number(&size["kerning"])
        );
        let names = ["A", "B", "space", "Aacute"];
        let label = label(&mut runtime, screen, font, &expected, &names, 4)?;
        verify_label(&mut runtime, display, label, &expected, size, &names, true)?;
        runtime
            .raw()?
            .lv_font_set_kerning(font, values::LV_FONT_KERNING_NONE)?;
        runtime
            .raw()?
            .lv_obj_report_style_change(UnsafePointer(0))?;
        assert_eq!(
            runtime.raw()?.lv_font_get_glyph_width(font, left, right)?,
            number(&size["glyphs"]["A"]["advance"])
        );
        verify_label(&mut runtime, display, label, &expected, size, &names, false)?;
        runtime.raw()?.lv_obj_delete(label)?;
        runtime.raw()?.lv_tiny_ttf_destroy(font)?;
    }
    runtime.free(data.0.0)?;
    runtime.shutdown()
}

#[test]
fn tinyttf_fallback_resolves_missing_glyphs_and_keeps_font_ownership_separate() -> Result<()> {
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    let primary_data = data(&mut runtime, &expected["font"])?;
    let fallback_data = data(&mut runtime, &expected["fallback"])?;
    let size = &expected["sizes"][1];
    let primary = create_font(&mut runtime, primary_data, size, Some(1))?;
    let fallback = create_font(&mut runtime, fallback_data, size, Some(0))?;
    let descriptor = UnsafePointer(runtime.alloc(values::LV_FONT_GLYPH_DSC_T_SIZE)?);
    let omega = number(&expected["codepoints"]["Omega"]);
    assert_eq!(
        runtime
            .raw()?
            .lv_font_get_glyph_dsc(primary, descriptor, omega, 0)?,
        0
    );
    assert_eq!(
        read_u32(
            &runtime,
            descriptor.0 + offset(values::LV_FONT_GLYPH_DSC_T_FIELDS, "resolved_font")
        )?,
        0
    );
    runtime.write_memory(
        primary.0 + offset(values::LV_FONT_T_FIELDS, "fallback"),
        &fallback.0.to_le_bytes(),
    )?;
    verify_glyph(&mut runtime, primary, fallback, &expected, size, "Omega")?;
    verify_glyph(&mut runtime, primary, primary, &expected, size, "A")?;
    let object = label(&mut runtime, screen, primary, &expected, &["A", "Omega"], 4)?;
    verify_label(
        &mut runtime,
        display,
        object,
        &expected,
        size,
        &["A", "Omega"],
        true,
    )?;
    runtime
        .raw()?
        .lv_obj_set_style_text_font(object, fallback, values::LV_PART_MAIN)?;
    set_text(&mut runtime, object, &expected, &["Omega"])?;
    runtime.write_memory(
        primary.0 + offset(values::LV_FONT_T_FIELDS, "fallback"),
        &0u32.to_le_bytes(),
    )?;
    runtime.raw()?.lv_tiny_ttf_destroy(primary)?;
    runtime.free(primary_data.0.0)?;
    verify_label(
        &mut runtime,
        display,
        object,
        &expected,
        size,
        &["Omega"],
        false,
    )?;
    runtime.raw()?.lv_obj_delete(object)?;
    runtime.raw()?.lv_tiny_ttf_destroy(fallback)?;
    runtime.free(fallback_data.0.0)?;
    runtime.free(descriptor.0)?;
    runtime.shutdown()
}

#[test]
fn tinyttf_cache_resize_and_shared_labels_follow_explicit_font_lifetimes() -> Result<()> {
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    let data = data(&mut runtime, &expected["font"])?;
    let small = &expected["sizes"][0];
    let large = &expected["sizes"][2];
    assert_eq!(
        runtime
            .raw()?
            .lv_tiny_ttf_create_data(UnsafePointer(0), data.1, 16)?,
        UnsafePointer(0)
    );
    for size in [0, -1] {
        assert_eq!(
            runtime
                .raw()?
                .lv_tiny_ttf_create_data(data.0, data.1, size)?,
            UnsafePointer(0)
        );
    }
    for cache in [Some(0), Some(1), None] {
        let font = create_font(&mut runtime, data, small, cache)?;
        for name in ["A", "B", "Aacute", "A"] {
            verify_glyph(&mut runtime, font, font, &expected, small, name)?;
        }
        let first = label(&mut runtime, screen, font, &expected, &["A", "B"], 4)?;
        let second = label(&mut runtime, screen, font, &expected, &["Aacute", "B"], 44)?;
        verify_label(
            &mut runtime,
            display,
            first,
            &expected,
            small,
            &["A", "B"],
            true,
        )?;
        verify_label(
            &mut runtime,
            display,
            second,
            &expected,
            small,
            &["Aacute", "B"],
            true,
        )?;
        runtime
            .raw()?
            .lv_tiny_ttf_set_size(font, number(&large["size"]))?;
        runtime
            .raw()?
            .lv_obj_report_style_change(UnsafePointer(0))?;
        verify_glyph(&mut runtime, font, font, &expected, large, "A")?;
        verify_label(
            &mut runtime,
            display,
            first,
            &expected,
            large,
            &["A", "B"],
            true,
        )?;
        verify_label(
            &mut runtime,
            display,
            second,
            &expected,
            large,
            &["Aacute", "B"],
            true,
        )?;
        runtime.raw()?.lv_obj_delete(first)?;
        verify_label(
            &mut runtime,
            display,
            second,
            &expected,
            large,
            &["Aacute", "B"],
            true,
        )?;
        let replacement = create_font(&mut runtime, data, small, None)?;
        runtime
            .raw()?
            .lv_obj_set_style_text_font(second, replacement, values::LV_PART_MAIN)?;
        set_text(&mut runtime, second, &expected, &["B"])?;
        runtime.raw()?.lv_tiny_ttf_destroy(font)?;
        verify_label(
            &mut runtime,
            display,
            second,
            &expected,
            small,
            &["B"],
            false,
        )?;
        runtime.raw()?.lv_obj_delete(second)?;
        runtime.raw()?.lv_tiny_ttf_destroy(replacement)?;
    }
    runtime.free(data.0.0)?;
    runtime.shutdown()
}
