function(lvw_thorvg_load target relative expected)
    set(source "${lvgl_SOURCE_DIR}/${relative}")
    get_filename_component(name "${source}" NAME)
    set(adapted "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/${name}")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${source}")
    file(SHA256 "${source}" actual)
    if(NOT actual STREQUAL expected)
        file(REMOVE "${adapted}")
        message(FATAL_ERROR "Unsupported ThorVG rendering source: ${source}")
    endif()
    file(READ "${source}" code)
    set(LVW_THORVG_TARGET "${target}" PARENT_SCOPE)
    set(LVW_THORVG_SOURCE "${source}" PARENT_SCOPE)
    set(LVW_THORVG_ADAPTED "${adapted}" PARENT_SCOPE)
    set(LVW_THORVG_CODE "${code}" PARENT_SCOPE)
endfunction()

function(lvw_thorvg_replace before after)
    string(FIND "${LVW_THORVG_CODE}" "${before}" first)
    string(FIND "${LVW_THORVG_CODE}" "${before}" last REVERSE)
    if(first LESS 0 OR NOT first EQUAL last)
        file(REMOVE "${LVW_THORVG_ADAPTED}")
        message(FATAL_ERROR "ThorVG rendering requires a unique source anchor")
    endif()
    string(REPLACE "${before}" "${after}" code "${LVW_THORVG_CODE}")
    set(LVW_THORVG_CODE "${code}" PARENT_SCOPE)
endfunction()

function(lvw_thorvg_save)
    file(CONFIGURE OUTPUT "${LVW_THORVG_ADAPTED}" CONTENT "${LVW_THORVG_CODE}" @ONLY)
    get_target_property(sources ${LVW_THORVG_TARGET} SOURCES)
    list(FIND sources "${LVW_THORVG_SOURCE}" index)
    if(index LESS 0)
        message(FATAL_ERROR "Expected ThorVG compilation unit: ${LVW_THORVG_SOURCE}")
    endif()
    list(REMOVE_ITEM sources "${LVW_THORVG_SOURCE}")
    list(INSERT sources ${index} "${LVW_THORVG_ADAPTED}")
    set_property(TARGET ${LVW_THORVG_TARGET} PROPERTY SOURCES "${sources}")
    get_filename_component(directory "${LVW_THORVG_SOURCE}" DIRECTORY)
    set_source_files_properties("${LVW_THORVG_ADAPTED}" TARGET_DIRECTORY ${LVW_THORVG_TARGET}
        PROPERTIES INCLUDE_DIRECTORIES "${directory}")
endfunction()

# Straight-alpha LVGL layers must be premultiplied before ThorVG composes into them.
set(LVW_THORVG_PREMULTIPLY [=[    if (surface->cs == ColorSpace::ABGR8888S || surface->cs == ColorSpace::ARGB8888S) {
        for (uint32_t y = 0; y < surface->h; y++) {
            auto row = surface->buf32 + y * surface->stride;
            for (uint32_t x = 0; x < surface->w; x++) {
                uint32_t alpha = row[x] >> 24;
                if (alpha < 255) row[x] = (row[x] & 0xff000000) | (ALPHA_BLEND(row[x], alpha) & 0x00ffffff);
            }
        }
        surface->premultiplied = true;
    }
]=])

# Validate every selected unit before replacing any target source.
set(LVW_THORVG_CONFIG "${lvgl_SOURCE_DIR}/src/libs/thorvg/config.h")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LVW_THORVG_CONFIG}")
file(SHA256 "${LVW_THORVG_CONFIG}" hash)
lvw_config_flag(LV_USE_VECTOR_GRAPHIC)
if(hash STREQUAL "98e59951e6a8b7a231abceec7f5a03af65c8a0b06c89f0e59aee6669f2b98823")
    set(units src/libs/thorvg/tvgSwRenderer.cpp)
    set(hashes fd022549ecf2ecbb13870ca401d77817f8101f6b25fd5a218470a9c901c6c6cd)
    set(vector_hash c6c29642949ba71b8238f500d3ed0bd31f5c3a3ab26b16b68efff5a6e41cbda6)
elseif(hash STREQUAL "70c1cfdaa888d1a4d74444a7e33e956b4a84110ceb0a53c0af4873e292bdc15d")
    set(units src/libs/thorvg/tvgSvgLoader.cpp src/libs/thorvg/tvgSwRenderer.cpp)
    set(hashes 1d2c2e26a0b96566ecde92f72bde10588f90009cd0a1a3f41befb214f597aa2b
        81bd600c600ac16dd23db625a3b08ed4f7fc01b6e9beb8c4d1dfcb8e6f9c4c35)
    set(vector_hash 0ebf0ded4040e0763720a3ddef941b3932f05bad5b0852a1ba6be3546089500a)
else()
    set(invalid "${LVW_THORVG_CONFIG}")
endif()
if(LV_USE_VECTOR_GRAPHIC)
    list(APPEND units src/draw/sw/lv_draw_sw_vector.c)
    list(APPEND hashes "${vector_hash}")
endif()
if(NOT invalid)
    foreach(unit expected IN ZIP_LISTS units hashes)
        set(source "${lvgl_SOURCE_DIR}/${unit}")
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${source}")
        file(SHA256 "${source}" actual)
        if(NOT actual STREQUAL expected)
            set(invalid "${source}")
            break()
        endif()
    endforeach()
endif()
if(invalid)
    foreach(name tvgSvgLoader.cpp tvgSwRenderer.cpp lv_draw_sw_vector.c)
        file(REMOVE "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/${name}")
    endforeach()
    message(FATAL_ERROR "Unsupported ThorVG source: ${invalid}")
endif()
if(hash STREQUAL "98e59951e6a8b7a231abceec7f5a03af65c8a0b06c89f0e59aee6669f2b98823")
    lvw_thorvg_load(lvgl_thorvg src/libs/thorvg/tvgSwRenderer.cpp
        fd022549ecf2ecbb13870ca401d77817f8101f6b25fd5a218470a9c901c6c6cd)
    lvw_thorvg_replace("bool SwRenderer::preRender()\n{\n    return true;\n}"
        "bool SwRenderer::preRender()\n{\n${LVW_THORVG_PREMULTIPLY}    return true;\n}")
    lvw_thorvg_save()
    lvw_config_flag(LV_USE_VECTOR_GRAPHIC)
    if(LV_USE_VECTOR_GRAPHIC)
        lvw_thorvg_load(lvgl src/draw/sw/lv_draw_sw_vector.c
            c6c29642949ba71b8238f500d3ed0bd31f5c3a3ab26b16b68efff5a6e41cbda6)
        lvw_thorvg_replace("tvg_swcanvas_set_target(canvas, buf, stride / 4, width, height, TVG_COLORSPACE_ARGB8888);"
            "tvg_swcanvas_set_target(canvas, buf, stride / 4, width, height, cf == LV_COLOR_FORMAT_XRGB8888 ? TVG_COLORSPACE_ARGB8888 : TVG_COLORSPACE_ARGB8888S);")
        lvw_thorvg_save()
    endif()
    # The modern file loader is handled together with the Lottie adapter.
    return()
endif()

# Route the pinned legacy SVG file loader through LVGL's resource filesystem.
lvw_thorvg_load(lvgl_thorvg src/libs/thorvg/tvgSvgLoader.cpp
    1d2c2e26a0b96566ecde92f72bde10588f90009cd0a1a3f41befb214f597aa2b)
set(before [=[    ifstream f;
    f.open(path);

    if (!f.is_open()) return false;

    svgPath = path;
    getline(f, filePath, '\0');
    f.close();

    if (filePath.empty()) return false;
]=])
set(after [=[    uint32_t length;
    auto data = lvw_thorvg_read_file(path.c_str(), &length);
    if (!data) return false;
    svgPath = path;
    filePath.assign(data, length);
    lv_free(data);
]=])
lvw_thorvg_replace("${before}" "${after}")
lvw_thorvg_save()
target_compile_definitions(lvgl_thorvg PRIVATE LVW_THORVG_FILE_LOADER=1)

lvw_thorvg_load(lvgl_thorvg src/libs/thorvg/tvgSwRenderer.cpp
    81bd600c600ac16dd23db625a3b08ed4f7fc01b6e9beb8c4d1dfcb8e6f9c4c35)
lvw_thorvg_replace([=[#if LV_USE_DRAW_VG_LITE && LV_USE_VG_LITE_THORVG
    return true;
#else
    return rasterClear(surface, 0, 0, surface->w, surface->h);
#endif]=] "    // LVGL owns and initializes the target, including earlier draw tasks.\n${LVW_THORVG_PREMULTIPLY}    return true;")
string(APPEND LVW_THORVG_CODE [=[

extern "C" int lvw_tvg_set_straight_target(void * canvas, uint32_t * pixels,
                                         uint32_t stride, uint32_t width, uint32_t height)
{
    return static_cast<int>(static_cast<tvg::SwCanvas *>(canvas)->target(
        pixels, stride, width, height, tvg::SwCanvas::ARGB8888S));
}
]=])
lvw_thorvg_save()

lvw_config_flag(LV_USE_VECTOR_GRAPHIC)
if(NOT LV_USE_VECTOR_GRAPHIC)
    return()
endif()
lvw_thorvg_load(lvgl src/draw/sw/lv_draw_sw_vector.c
    0ebf0ded4040e0763720a3ddef941b3932f05bad5b0852a1ba6be3546089500a)
lvw_thorvg_replace("} _tvg_color;" [=[} _tvg_color;

typedef struct {
    Tvg_Canvas * canvas;
    int32_t x;
    int32_t y;
    const lv_area_t * clip;
} lvw_vector_state;

extern int lvw_tvg_set_straight_target(void * canvas, uint32_t * pixels,
                                     uint32_t stride, uint32_t width, uint32_t height);]=])
lvw_thorvg_replace([=[    Tvg_Canvas * canvas = (Tvg_Canvas *)ctx;

    Tvg_Paint * obj = tvg_shape_new();]=] [=[    lvw_vector_state * state = ctx;
    Tvg_Canvas * canvas = state->canvas;
    lv_area_t clip;
    if(!_lv_area_intersect(&clip, &dsc->scissor_area, state->clip)) return;
    Tvg_Paint * obj = tvg_shape_new();
    Tvg_Paint * mask = tvg_shape_new();
    tvg_shape_append_rect(mask, clip.x1 + state->x, clip.y1 + state->y,
                         lv_area_get_width(&clip), lv_area_get_height(&clip), 0, 0);
    tvg_shape_set_fill_color(mask, 255, 255, 255, 255);
    tvg_paint_set_composite_method(obj, mask, TVG_COMPOSITE_METHOD_CLIP_PATH);]=])
lvw_thorvg_replace("tvg_shape_append_rect(obj, rc.x, rc.y, rc.w, rc.h, 0, 0);"
    "tvg_shape_append_rect(obj, rc.x + state->x, rc.y + state->y, rc.w, rc.h, 0, 0);")
lvw_thorvg_replace([=[        Tvg_Matrix mtx;
        _lv_matrix_to_tvg(&mtx, &dsc->matrix);]=] [=[        lv_matrix_t matrix;
        lv_matrix_identity(&matrix);
        lv_matrix_translate(&matrix, state->x, state->y);
        lv_matrix_multiply(&matrix, &dsc->matrix);
        Tvg_Matrix mtx;
        _lv_matrix_to_tvg(&mtx, &matrix);]=])
lvw_thorvg_replace("_set_paint_fill(obj, canvas, &dsc->fill_dsc, &dsc->matrix);"
    "_set_paint_fill(obj, canvas, &dsc->fill_dsc, &matrix);")
lvw_thorvg_replace("    LV_UNUSED(draw_unit);\n" "")
lvw_thorvg_replace("    tvg_swcanvas_set_target(canvas, buf, stride / 4, width, height, TVG_COLORSPACE_ARGB8888);"
    [=[    if(cf == LV_COLOR_FORMAT_ARGB8888) {
        lvw_tvg_set_straight_target(canvas, buf, stride / 4, width, height);
    }
    else {
        tvg_swcanvas_set_target(canvas, buf, stride / 4, width, height, TVG_COLORSPACE_ARGB8888);
    }]=])
lvw_thorvg_replace("    _lv_vector_for_each_destroy_tasks(task_list, _task_draw_cb, canvas);"
    [=[    lvw_vector_state state = {canvas, -layer->buf_area.x1, -layer->buf_area.y1, draw_unit->clip_area};
    _lv_vector_for_each_destroy_tasks(task_list, _task_draw_cb, &state);]=])
lvw_thorvg_save()
