use std::path::Path;

use liblvgl_wasm_host::{Result, Runtime, UnsafePointer, values};
use serde_json::Value;

fn expected() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/freetype/expected.json"
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

fn fixture(entry: &Value) -> Result<Vec<u8>> {
    Ok(std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/freetype")
            .join(entry["file"].as_str().unwrap()),
    )?)
}

fn upload(runtime: &mut Runtime, name: &str, bytes: &[u8]) -> Result<()> {
    let key = runtime.alloc(name.len() as u32)?;
    let data = runtime.alloc(bytes.len() as u32)?;
    runtime.write_memory(key, name.as_bytes())?;
    runtime.write_memory(data, bytes)?;
    assert_eq!(
        runtime.call_raw::<_, i32>(
            "lvw_resource_put",
            (key, name.len() as u32, data, bytes.len() as u32),
        )?,
        0
    );
    // Resource storage owns a copy; no font may depend on these upload buffers.
    runtime.write_memory(data, &vec![0; bytes.len()])?;
    runtime.write_memory(key, &vec![0; name.len()])?;
    runtime.free(data)?;
    runtime.free(key)
}

fn string(runtime: &mut Runtime, text: &str) -> Result<UnsafePointer> {
    let mut bytes = text.as_bytes().to_vec();
    bytes.push(0);
    let pointer = runtime.alloc(bytes.len() as u32)?;
    runtime.write_memory(pointer, &bytes)?;
    Ok(UnsafePointer(pointer))
}

fn create_font(runtime: &mut Runtime, name: &str, size: i32) -> Result<UnsafePointer> {
    create_font_mode(
        runtime,
        name,
        size,
        values::LV_FREETYPE_FONT_RENDER_MODE_BITMAP,
    )
}

fn create_font_mode(
    runtime: &mut Runtime,
    name: &str,
    size: i32,
    mode: i32,
) -> Result<UnsafePointer> {
    let path = format!("W:{name}");
    let pointer = string(runtime, &path)?;
    let info = UnsafePointer(runtime.alloc(values::LV_FONT_INFO_T_SIZE)?);
    runtime.raw()?.lv_freetype_init_font_info(info)?;
    for (field, value) in [
        ("name", pointer.0),
        ("size", size as u32),
        ("render_mode", mode as u32),
        ("kerning", values::LV_FONT_KERNING_NORMAL as u32),
    ] {
        runtime.write_memory(
            info.0 + offset(values::LV_FONT_INFO_T_FIELDS, field),
            &value.to_le_bytes(),
        )?;
    }
    let font = runtime.raw()?.lv_freetype_font_create_with_info(info)?;
    assert_ne!(font.0, 0);
    // FreeType keeps its own pathname copy, unlike raw fonts that borrow data buffers.
    runtime.write_memory(pointer.0, &vec![0; path.len() + 1])?;
    runtime.free(pointer.0)?;
    runtime.free(info.0)?;
    assert_eq!(
        runtime.raw()?.lv_freetype_is_outline_font(font)?,
        i32::from(mode == values::LV_FREETYPE_FONT_RENDER_MODE_OUTLINE)
    );
    Ok(font)
}

fn verify_metrics(runtime: &mut Runtime, font: UnsafePointer, size: &Value) -> Result<()> {
    assert_eq!(
        runtime.raw()?.lv_font_get_line_height(font)?,
        number(&size["line_height"])
    );
    assert_eq!(
        read_u32(
            runtime,
            font.0 + offset(values::LV_FONT_T_FIELDS, "base_line")
        )? as i32,
        number(&size["baseline"])
    );
    Ok(())
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
    // Empty glyphs have no draw buffer; the advance still participates in text layout.
    if number(&glyph["box_w"]) != 0 && number(&glyph["box_h"]) != 0 {
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
    }
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
    let text: String = names
        .iter()
        .map(|name| char::from_u32(number(&expected["codepoints"][name]) as u32).unwrap())
        .collect();
    let pointer = string(runtime, &text)?;
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
    let object = styled_label(runtime, screen, font, expected, y)?;
    set_text(runtime, object, expected, names)?;
    Ok(object)
}

fn styled_label(
    runtime: &mut Runtime,
    screen: UnsafePointer,
    font: UnsafePointer,
    expected: &Value,
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
    Ok(object)
}

fn frame(runtime: &mut Runtime, display: u32) -> Result<(Vec<u8>, u32)> {
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
    Ok((pixels, word(24)))
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
    let mut vector = vec![false; width * height];
    let font = runtime
        .raw()?
        .lv_obj_get_style_text_font(label, values::LV_PART_MAIN)?;
    let opacity = runtime
        .raw()?
        .lv_obj_get_style_text_opa(label, values::LV_PART_MAIN)?;
    let glyph_descriptor = UnsafePointer(runtime.alloc(values::LV_FONT_GLYPH_DSC_T_SIZE)?);
    for ((pen, glyph), name) in placed.into_iter().zip(names) {
        assert_eq!(
            runtime.raw()?.lv_font_get_glyph_dsc(
                font,
                glyph_descriptor,
                number(&expected["codepoints"][name]),
                0
            )?,
            1
        );
        let is_vector = read_u32(
            runtime,
            glyph_descriptor.0 + offset(values::LV_FONT_GLYPH_DSC_T_FIELDS, "format"),
        )? == values::LV_FONT_GLYPH_FORMAT_VECTOR as u32;
        let left = pen + number(&glyph["ofs_x"]);
        let top = number(&size["line_height"])
            - number(&size["baseline"])
            - number(&glyph["box_h"])
            - number(&glyph["ofs_y"]);
        for (row, values) in glyph["alpha"].as_array().unwrap().iter().enumerate() {
            for (column, value) in values.as_array().unwrap().iter().enumerate() {
                alpha[(top as usize + row) * width + left as usize + column] = number(value);
                vector[(top as usize + row) * width + left as usize + column] = is_vector;
            }
        }
    }
    runtime.free(glyph_descriptor.0)?;
    runtime.raw()?.lv_obj_update_layout(label)?;
    let y = runtime.raw()?.lv_obj_get_y(label)?;
    assert_eq!(runtime.raw()?.lv_obj_get_width(label)?, width as i32);
    assert_eq!(runtime.raw()?.lv_obj_get_height(label)?, height as i32);
    runtime.raw()?.lv_obj_invalidate(label)?;
    let (pixels, stride) = frame(runtime, display)?;
    for row in -1..=height as i32 {
        for column in -1..=width as i32 {
            let coverage =
                if row < 0 || column < 0 || row == height as i32 || column == width as i32 {
                    0
                } else {
                    alpha[row as usize * width + column as usize]
                };
            let position = ((y + row) as usize * stride as usize) + (4 + column) as usize * 4;
            for channel in 0..3 {
                let foreground = number(&expected["foreground"][channel]);
                let background = number(&expected["background"][channel]);
                let is_vector = row >= 0
                    && column >= 0
                    && row < height as i32
                    && column < width as i32
                    && vector[row as usize * width + column as usize];
                // Outline coverage is rasterized into a premultiplied image before compositing.
                let opacity = if is_vector {
                    (255 * opacity) / 256
                } else {
                    opacity
                };
                let effective = f64::from(coverage * opacity) / 255.0;
                let reference = ((f64::from(foreground) * effective
                    + f64::from(background) * (255.0 - effective))
                    / 255.0)
                    .floor() as i32;
                let actual = pixels[position + 2 - channel] as i32;
                let tolerance =
                    if coverage == 0 || (!is_vector && coverage == 255 && opacity == 255) {
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
fn freetype_metrics_bitmap_kerning_and_fallback_match_geometric_reference() -> Result<()> {
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    upload(&mut runtime, "geometry.ttf", &fixture(&expected["font"])?)?;
    upload(
        &mut runtime,
        "fallback.ttf",
        &fixture(&expected["fallback"])?,
    )?;
    for size in expected["sizes"].as_array().unwrap() {
        let font = create_font(&mut runtime, "geometry.ttf", number(&size["size"]))?;
        let fallback = create_font(&mut runtime, "fallback.ttf", number(&size["size"]))?;
        verify_metrics(&mut runtime, font, size)?;
        for name in ["space", "A", "B", "Aacute"] {
            verify_glyph(&mut runtime, font, font, &expected, size, name)?;
        }
        runtime.write_memory(
            font.0 + offset(values::LV_FONT_T_FIELDS, "fallback"),
            &fallback.0.to_le_bytes(),
        )?;
        verify_glyph(&mut runtime, font, fallback, &expected, size, "Omega")?;
        let left = number(&expected["kerning"]["left"]);
        let right = number(&expected["kerning"]["right"]);
        assert_eq!(
            runtime.raw()?.lv_font_get_glyph_width(font, left, right)?,
            number(&size["glyphs"]["A"]["advance"]) - number(&size["kerning"])
        );
        let names = ["A", "B", "space", "Aacute", "Omega"];
        let object = label(&mut runtime, screen, font, &expected, &names, 4)?;
        verify_label(&mut runtime, display, object, &expected, size, &names, true)?;
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
        verify_label(
            &mut runtime,
            display,
            object,
            &expected,
            size,
            &names,
            false,
        )?;
        runtime.raw()?.lv_obj_delete(object)?;
        runtime.write_memory(
            font.0 + offset(values::LV_FONT_T_FIELDS, "fallback"),
            &0u32.to_le_bytes(),
        )?;
        runtime.raw()?.lv_freetype_font_delete(font)?;
        runtime.raw()?.lv_freetype_font_delete(fallback)?;
    }
    runtime.shutdown()
}

#[test]
fn freetype_shared_faces_preserve_sizes_and_font_owners() -> Result<()> {
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    upload(&mut runtime, "shared.ttf", &fixture(&expected["font"])?)?;
    let small = &expected["sizes"][0];
    let large = &expected["sizes"][1];
    let first_font = create_font(&mut runtime, "shared.ttf", number(&small["size"]))?;
    let second_font = create_font(&mut runtime, "shared.ttf", number(&large["size"]))?;
    for (font, size, name) in [
        (first_font, small, "A"),
        (second_font, large, "B"),
        (first_font, small, "B"),
        (second_font, large, "Aacute"),
        (first_font, small, "A"),
    ] {
        verify_metrics(&mut runtime, font, size)?;
        verify_glyph(&mut runtime, font, font, &expected, size, name)?;
    }
    let first = label(&mut runtime, screen, first_font, &expected, &["A", "B"], 4)?;
    let second = label(
        &mut runtime,
        screen,
        first_font,
        &expected,
        &["Aacute", "B"],
        44,
    )?;
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
    runtime.raw()?.lv_obj_delete(first)?;
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
        .lv_obj_set_style_text_font(second, second_font, values::LV_PART_MAIN)?;
    runtime.raw()?.lv_freetype_font_delete(first_font)?;
    verify_label(
        &mut runtime,
        display,
        second,
        &expected,
        large,
        &["Aacute", "B"],
        true,
    )?;
    let replacement = create_font(&mut runtime, "shared.ttf", number(&small["size"]))?;
    verify_glyph(
        &mut runtime,
        replacement,
        replacement,
        &expected,
        small,
        "A",
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
    runtime
        .raw()?
        .lv_obj_set_style_text_font(second, replacement, values::LV_PART_MAIN)?;
    runtime.raw()?.lv_freetype_font_delete(second_font)?;
    verify_label(
        &mut runtime,
        display,
        second,
        &expected,
        small,
        &["Aacute", "B"],
        true,
    )?;
    runtime.raw()?.lv_obj_delete(second)?;
    runtime.raw()?.lv_freetype_font_delete(replacement)?;
    runtime.shutdown()
}

#[test]
fn freetype_resource_copies_and_failed_opens_leave_the_runtime_usable() -> Result<()> {
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    let mut bytes = fixture(&expected["font"])?;
    upload(&mut runtime, "copied.ttf", &bytes)?;
    bytes.fill(0);
    let empty = string(&mut runtime, "")?;
    let missing = string(&mut runtime, "W:missing.ttf")?;
    let valid = string(&mut runtime, "W:copied.ttf")?;
    for rejected in expected["rejected"].as_array().unwrap() {
        let bytes = if rejected["source"].is_string() {
            let source = fixture(&expected[rejected["source"].as_str().unwrap()])?;
            source[..number(&rejected["length"]) as usize].to_vec()
        } else {
            rejected["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| number(value) as u8)
                .collect()
        };
        let name = rejected["name"].as_str().unwrap();
        upload(&mut runtime, name, &bytes)?;
        let path = string(&mut runtime, &format!("W:{name}"))?;
        assert_eq!(
            runtime.raw()?.lv_freetype_font_create(
                path,
                values::LV_FREETYPE_FONT_RENDER_MODE_BITMAP,
                16,
                values::LV_FREETYPE_FONT_STYLE_NORMAL
            )?,
            UnsafePointer(0)
        );
        runtime.free(path.0)?;
    }
    for (path, size) in [
        (UnsafePointer(0), 16),
        (empty, 16),
        (missing, 16),
        (valid, 0),
    ] {
        assert_eq!(
            runtime.raw()?.lv_freetype_font_create(
                path,
                values::LV_FREETYPE_FONT_RENDER_MODE_BITMAP,
                size,
                values::LV_FREETYPE_FONT_STYLE_NORMAL
            )?,
            UnsafePointer(0)
        );
    }
    let recovery = &expected["cmap_recovery"];
    let original: Vec<u8> = recovery["original"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| number(value) as u8)
        .collect();
    let replacement: Vec<u8> = recovery["bytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| number(value) as u8)
        .collect();
    let mut recovering_bytes = fixture(&expected["font"])?;
    let start = number(&recovery["offset"]) as usize;
    let range = start..start + original.len();
    assert_eq!(recovering_bytes[range.clone()], original);
    assert_eq!(original.len(), replacement.len());
    recovering_bytes[range].copy_from_slice(&replacement);
    let name = recovery["name"].as_str().unwrap();
    upload(&mut runtime, name, &recovering_bytes)?;
    // The invalid cmap invokes validator longjmp; glyph names recover the mapping.
    let recovered = create_font(&mut runtime, name, 16)?;
    for name in ["A", "Aacute"] {
        verify_glyph(
            &mut runtime,
            recovered,
            recovered,
            &expected,
            &expected["sizes"][0],
            name,
        )?;
    }
    runtime.raw()?.lv_freetype_font_delete(recovered)?;
    let font = runtime.raw()?.lv_freetype_font_create(
        valid,
        values::LV_FREETYPE_FONT_RENDER_MODE_BITMAP,
        16,
        values::LV_FREETYPE_FONT_STYLE_NORMAL,
    )?;
    assert_ne!(font.0, 0);
    runtime.write_memory(valid.0, b"W:missing.xx\0")?;
    runtime.free(valid.0)?;
    runtime.free(missing.0)?;
    runtime.free(empty.0)?;
    let size = &expected["sizes"][0];
    verify_glyph(&mut runtime, font, font, &expected, size, "A")?;
    let object = label(&mut runtime, screen, font, &expected, &["A", "B"], 4)?;
    // The simple creation API defaults to no kerning.
    verify_label(
        &mut runtime,
        display,
        object,
        &expected,
        size,
        &["A", "B"],
        false,
    )?;
    runtime.raw()?.lv_obj_delete(object)?;
    runtime.raw()?.lv_freetype_font_delete(font)?;
    let recreated = create_font(&mut runtime, "copied.ttf", 32)?;
    verify_glyph(
        &mut runtime,
        recreated,
        recreated,
        &expected,
        &expected["sizes"][1],
        "B",
    )?;
    runtime.raw()?.lv_freetype_font_delete(recreated)?;
    runtime.shutdown()
}

fn acquire_outline(
    runtime: &mut Runtime,
    font: UnsafePointer,
    resolved: UnsafePointer,
    codepoint: i32,
) -> Result<(UnsafePointer, UnsafePointer)> {
    let descriptor = UnsafePointer(runtime.alloc(values::LV_FONT_GLYPH_DSC_T_SIZE)?);
    assert_eq!(
        runtime
            .raw()?
            .lv_font_get_glyph_dsc(font, descriptor, codepoint, 0)?,
        1
    );
    assert_eq!(
        read_u32(
            runtime,
            descriptor.0 + offset(values::LV_FONT_GLYPH_DSC_T_FIELDS, "format")
        )?,
        values::LV_FONT_GLYPH_FORMAT_VECTOR as u32
    );
    assert_eq!(
        read_u32(
            runtime,
            descriptor.0 + offset(values::LV_FONT_GLYPH_DSC_T_FIELDS, "resolved_font")
        )?,
        resolved.0
    );
    // VECTOR draw data is a borrowed native path, never an A8 draw buffer.
    let path = runtime
        .raw()?
        .lv_font_get_glyph_bitmap(descriptor, UnsafePointer(0))?;
    assert_ne!(path.0, 0);
    assert_ne!(
        read_u32(
            runtime,
            descriptor.0 + offset(values::LV_FONT_GLYPH_DSC_T_FIELDS, "entry")
        )?,
        0
    );
    Ok((descriptor, path))
}

fn release_outline(runtime: &mut Runtime, descriptor: UnsafePointer) -> Result<()> {
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

#[test]
fn freetype_outline_sizes_opacity_and_shared_paths_match_geometric_reference() -> Result<()> {
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    upload(&mut runtime, "outline.ttf", &fixture(&expected["font"])?)?;
    upload(
        &mut runtime,
        "fallback.ttf",
        &fixture(&expected["fallback"])?,
    )?;
    let names = ["A", "B", "space", "Aacute", "Omega"];
    let mut fonts = Vec::new();
    let mut fallbacks = Vec::new();
    let mut labels = Vec::new();
    for (index, size) in expected["sizes"].as_array().unwrap().iter().enumerate() {
        let font = create_font_mode(
            &mut runtime,
            "outline.ttf",
            number(&size["size"]),
            values::LV_FREETYPE_FONT_RENDER_MODE_OUTLINE,
        )?;
        let fallback = create_font_mode(
            &mut runtime,
            "fallback.ttf",
            number(&size["size"]),
            values::LV_FREETYPE_FONT_RENDER_MODE_OUTLINE,
        )?;
        verify_metrics(&mut runtime, font, size)?;
        assert_eq!(
            runtime.raw()?.lv_freetype_outline_get_scale(font)?,
            number(&size["size"]) * 64 / 128
        );
        runtime.write_memory(
            font.0 + offset(values::LV_FONT_T_FIELDS, "fallback"),
            &fallback.0.to_le_bytes(),
        )?;
        let object = label(
            &mut runtime,
            screen,
            font,
            &expected,
            &names,
            4 + index as i32 * 40,
        )?;
        // A real label draw installs the software backend's native outline callback.
        for opacity in [255, 128, 255] {
            runtime
                .raw()?
                .lv_obj_set_style_text_opa(object, opacity, values::LV_PART_MAIN)?;
            verify_label(&mut runtime, display, object, &expected, size, &names, true)?;
        }
        let (glyph, _) = acquire_outline(
            &mut runtime,
            font,
            fallback,
            number(&expected["codepoints"]["Omega"]),
        )?;
        release_outline(&mut runtime, glyph)?;
        fonts.push(font);
        fallbacks.push(fallback);
        labels.push(object);
    }
    let codepoint = number(&expected["codepoints"]["Aacute"]);
    let (small_glyph, small_path) = acquire_outline(&mut runtime, fonts[0], fonts[0], codepoint)?;
    let (large_glyph, large_path) = acquire_outline(&mut runtime, fonts[1], fonts[1], codepoint)?;
    assert_eq!(
        small_path, large_path,
        "live sizes share the reference-size outline path"
    );
    let entry = offset(values::LV_FONT_GLYPH_DSC_T_FIELDS, "entry");
    assert_eq!(
        read_u32(&runtime, small_glyph.0 + entry)?,
        read_u32(&runtime, large_glyph.0 + entry)?
    );
    release_outline(&mut runtime, small_glyph)?;
    runtime.raw()?.lv_obj_delete(labels[0])?;
    runtime.write_memory(
        fonts[0].0 + offset(values::LV_FONT_T_FIELDS, "fallback"),
        &0u32.to_le_bytes(),
    )?;
    runtime.raw()?.lv_freetype_font_delete(fonts[0])?;
    runtime.raw()?.lv_freetype_font_delete(fallbacks[0])?;
    verify_label(
        &mut runtime,
        display,
        labels[1],
        &expected,
        &expected["sizes"][1],
        &names,
        true,
    )?;
    assert_ne!(read_u32(&runtime, large_glyph.0 + entry)?, 0);
    release_outline(&mut runtime, large_glyph)?;
    runtime.raw()?.lv_obj_delete(labels[1])?;
    runtime.write_memory(
        fonts[1].0 + offset(values::LV_FONT_T_FIELDS, "fallback"),
        &0u32.to_le_bytes(),
    )?;
    runtime.raw()?.lv_freetype_font_delete(fonts[1])?;
    runtime.raw()?.lv_freetype_font_delete(fallbacks[1])?;
    runtime.shutdown()
}

#[test]
fn freetype_bitmap_and_outline_fonts_keep_mixed_fallbacks_and_owners_independent() -> Result<()> {
    let expected = expected();
    let (mut runtime, display, screen) = load(&expected)?;
    upload(&mut runtime, "mixed.ttf", &fixture(&expected["font"])?)?;
    upload(
        &mut runtime,
        "fallback.ttf",
        &fixture(&expected["fallback"])?,
    )?;
    let small = &expected["sizes"][0];
    let large = &expected["sizes"][1];
    let bitmap = create_font(&mut runtime, "mixed.ttf", number(&small["size"]))?;
    let outline = create_font_mode(
        &mut runtime,
        "mixed.ttf",
        number(&small["size"]),
        values::LV_FREETYPE_FONT_RENDER_MODE_OUTLINE,
    )?;
    let bitmap_fallback = create_font(&mut runtime, "fallback.ttf", number(&small["size"]))?;
    let outline_fallback = create_font_mode(
        &mut runtime,
        "fallback.ttf",
        number(&small["size"]),
        values::LV_FREETYPE_FONT_RENDER_MODE_OUTLINE,
    )?;
    // Each label crosses the renderer boundary through its missing Omega glyph.
    runtime.write_memory(
        bitmap.0 + offset(values::LV_FONT_T_FIELDS, "fallback"),
        &outline_fallback.0.to_le_bytes(),
    )?;
    runtime.write_memory(
        outline.0 + offset(values::LV_FONT_T_FIELDS, "fallback"),
        &bitmap_fallback.0.to_le_bytes(),
    )?;
    let names = ["A", "B", "Aacute", "Omega"];
    let first = label(&mut runtime, screen, outline, &expected, &names, 4)?;
    let second = label(&mut runtime, screen, bitmap, &expected, &names, 44)?;
    verify_label(&mut runtime, display, first, &expected, small, &names, true)?;
    verify_label(
        &mut runtime,
        display,
        second,
        &expected,
        small,
        &names,
        true,
    )?;
    verify_glyph(&mut runtime, bitmap, bitmap, &expected, small, "A")?;
    verify_glyph(
        &mut runtime,
        outline,
        bitmap_fallback,
        &expected,
        small,
        "Omega",
    )?;
    let (glyph, _) = acquire_outline(
        &mut runtime,
        bitmap,
        outline_fallback,
        number(&expected["codepoints"]["Omega"]),
    )?;
    release_outline(&mut runtime, glyph)?;
    runtime
        .raw()?
        .lv_obj_set_style_text_font(first, bitmap, values::LV_PART_MAIN)?;
    runtime.write_memory(
        outline.0 + offset(values::LV_FONT_T_FIELDS, "fallback"),
        &0u32.to_le_bytes(),
    )?;
    runtime.raw()?.lv_freetype_font_delete(outline)?;
    runtime.raw()?.lv_freetype_font_delete(bitmap_fallback)?;
    verify_label(&mut runtime, display, first, &expected, small, &names, true)?;
    let replacement = create_font_mode(
        &mut runtime,
        "mixed.ttf",
        number(&large["size"]),
        values::LV_FREETYPE_FONT_RENDER_MODE_OUTLINE,
    )?;
    runtime.raw()?.lv_obj_delete(second)?;
    runtime
        .raw()?
        .lv_obj_set_style_text_font(first, replacement, values::LV_PART_MAIN)?;
    runtime.write_memory(
        bitmap.0 + offset(values::LV_FONT_T_FIELDS, "fallback"),
        &0u32.to_le_bytes(),
    )?;
    runtime.raw()?.lv_freetype_font_delete(bitmap)?;
    runtime.raw()?.lv_freetype_font_delete(outline_fallback)?;
    set_text(&mut runtime, first, &expected, &["A", "B", "Aacute"])?;
    verify_label(
        &mut runtime,
        display,
        first,
        &expected,
        large,
        &["A", "B", "Aacute"],
        true,
    )?;
    runtime.raw()?.lv_obj_delete(first)?;
    runtime.raw()?.lv_freetype_font_delete(replacement)?;
    runtime.shutdown()
}

#[test]
fn freetype_outline_quadratic_and_cubic_curves_stay_within_analytic_curve_bounds() -> Result<()> {
    let expected: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/freetype-outline/expected.json"
    ))
    .unwrap();
    let (mut runtime, display, screen) = load(&expected)?;
    for font in expected["fonts"].as_array().unwrap() {
        let name = font["file"].as_str().unwrap();
        let bytes = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../tests/fixtures/freetype-outline")
                .join(name),
        )?;
        upload(&mut runtime, name, &bytes)?;
        for size in expected["sizes"].as_array().unwrap() {
            let font = create_font_mode(
                &mut runtime,
                name,
                number(&size["size"]),
                values::LV_FREETYPE_FONT_RENDER_MODE_OUTLINE,
            )?;
            verify_metrics(&mut runtime, font, size)?;
            let object = styled_label(&mut runtime, screen, font, &expected, 4)?;
            let character = char::from_u32(number(&expected["codepoint"]) as u32)
                .unwrap()
                .to_string();
            let text = string(&mut runtime, &character)?;
            runtime.raw()?.lv_label_set_text(object, text)?;
            runtime.free(text.0)?;
            runtime.raw()?.lv_obj_update_layout(object)?;
            let width = number(&size["advance"]);
            let height = number(&size["line_height"]);
            assert_eq!(runtime.raw()?.lv_obj_get_width(object)?, width);
            assert_eq!(runtime.raw()?.lv_obj_get_height(object)?, height);
            for opacity in [255, 128] {
                runtime
                    .raw()?
                    .lv_obj_set_style_text_opa(object, opacity, values::LV_PART_MAIN)?;
                runtime.raw()?.lv_obj_invalidate(object)?;
                let (pixels, stride) = frame(&mut runtime, display)?;
                for row in -1..=height {
                    for column in -1..=width {
                        let (minimum, maximum) =
                            if row >= 0 && column >= 0 && row < height && column < width {
                                (
                                    number(&size["coverage_min"][row as usize][column as usize]),
                                    number(&size["coverage_max"][row as usize][column as usize]),
                                )
                            } else {
                                (0, 0)
                            };
                        let position =
                            (4 + row) as usize * stride as usize + (4 + column) as usize * 4;
                        for channel in 0..3 {
                            let foreground = number(&expected["foreground"][channel]);
                            let background = number(&expected["background"][channel]);
                            let composite = |coverage| {
                                let effective = f64::from(coverage * (255 * opacity / 256)) / 255.0;
                                ((f64::from(foreground) * effective
                                    + f64::from(background) * (255.0 - effective))
                                    / 255.0)
                                    .floor() as i32
                            };
                            let first = composite(minimum);
                            let last = composite(maximum);
                            let lower = first.min(last);
                            let upper = first.max(last);
                            let actual = pixels[position + 2 - channel] as i32;
                            let tolerance = if maximum == 0 { 0 } else { 2 };
                            assert!(
                                actual >= lower - tolerance && actual <= upper + tolerance,
                                "{name} {}px opacity {opacity}, ({column}, {row}) channel {channel}: {actual} outside {lower}..={upper}, coverage {minimum}..={maximum}",
                                number(&size["size"])
                            );
                        }
                    }
                }
            }
            runtime.raw()?.lv_obj_delete(object)?;
            runtime.raw()?.lv_freetype_font_delete(font)?;
        }
    }
    runtime.shutdown()
}
