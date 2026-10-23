# Adapt verified PNG input handling without changing the selected source tree.
set(LVW_PNG_DIRECTORY "${lvgl_SOURCE_DIR}/src/libs/lodepng")
set(LVW_PNG_DECODER "${lvgl_SOURCE_DIR}/src/image/lv_lodepng.c")
if(NOT EXISTS "${LVW_PNG_DECODER}")
    set(LVW_PNG_DECODER "${LVW_PNG_DIRECTORY}/lv_lodepng.c")
endif()
set(LVW_PNG_LIBRARY "${LVW_PNG_DIRECTORY}/lodepng.c")
set(LVW_PNG_BINARY "${lvgl_SOURCE_DIR}/src/libs/bin_decoder/lv_bin_decoder.c")
set(LVW_PNG_CACHE "${lvgl_SOURCE_DIR}/src/misc/cache/lv_image_cache.c")
set(LVW_PNG_OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted")
set(LVW_PNG_OUTPUTS "${LVW_PNG_OUTPUT}/lv_lodepng.c" "${LVW_PNG_OUTPUT}/lodepng.c"
    "${LVW_PNG_OUTPUT}/lv_bin_decoder.c" "${LVW_PNG_OUTPUT}/lv_image_cache.c")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LVW_PNG_DECODER}" "${LVW_PNG_LIBRARY}")
file(SHA256 "${LVW_PNG_DECODER}" LVW_PNG_HASH)
if(LVW_PNG_HASH STREQUAL "a0965af70ff9f00e319fec9c993fa8e44d263c746bb5dcd4e4c9af154de062bb")
    set(LVW_PNG_EXPECTED "2e138b69f751c8dc304594dc1b4637959f2bcad8fb874bc1df57f0e68123a946")
    set(LVW_PNG_LEGACY OFF)
elseif(LVW_PNG_HASH STREQUAL "20f6f74e9c5b049b2bd50204bb8d67f68be30aa9a85bcc73cafa4de36ad0a233")
    set(LVW_PNG_EXPECTED "3c8aec65184ba2c9fd9f7192a904fa305742de4382510c6fb4b8176c5a0360c0")
    set(LVW_PNG_LEGACY ON)
else()
    file(REMOVE ${LVW_PNG_OUTPUTS})
    message(FATAL_ERROR "Unsupported LVGL lodepng source: ${LVW_PNG_DECODER}")
endif()
file(SHA256 "${LVW_PNG_LIBRARY}" LVW_PNG_HASH)
if(NOT LVW_PNG_HASH STREQUAL LVW_PNG_EXPECTED)
    file(REMOVE ${LVW_PNG_OUTPUTS})
    message(FATAL_ERROR "Unsupported LVGL lodepng source: ${LVW_PNG_LIBRARY}")
endif()
if(NOT LVW_PNG_LEGACY)
    return()
endif()
set(LVW_PNG_BINARY_HASH "419298d6c8a397f18e3a79661be508fbfbdbbe3d8b99b90157463d7e6019bd4e")
set(LVW_PNG_CACHE_HASH "11163cc5ac07aa7512ceff90c0c325f39262b9d484032e359ee43a13884a0fe7")
foreach(kind BINARY CACHE)
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LVW_PNG_${kind}}")
    file(SHA256 "${LVW_PNG_${kind}}" LVW_PNG_HASH)
    if(NOT LVW_PNG_HASH STREQUAL LVW_PNG_${kind}_HASH)
        file(REMOVE ${LVW_PNG_OUTPUTS})
        message(FATAL_ERROR "Unsupported LVGL lodepng source: ${LVW_PNG_${kind}}")
    endif()
endforeach()

function(lvw_png_replace before after)
    string(FIND "${LVW_PNG_CODE}" "${before}" first)
    string(FIND "${LVW_PNG_CODE}" "${before}" last REVERSE)
    if(first LESS 0 OR NOT first EQUAL last)
        file(REMOVE ${LVW_PNG_OUTPUTS})
        message(FATAL_ERROR "LVGL lodepng adaptation requires a unique source anchor")
    endif()
    string(REPLACE "${before}" "${after}" LVW_PNG_CODE "${LVW_PNG_CODE}")
    set(LVW_PNG_CODE "${LVW_PNG_CODE}" PARENT_SCOPE)
endfunction()

file(READ "${LVW_PNG_DECODER}" LVW_PNG_CODE)
string(FIND "${LVW_PNG_CODE}" "static lv_result_t decoder_info(lv_image_decoder_t * decoder, const void * src, lv_image_header_t * header)\n{" begin)
string(FIND "${LVW_PNG_CODE}" "/**\n * Open a PNG image" end)
math(EXPR length "${end} - ${begin}")
if(begin LESS 0 OR length LESS 0)
    message(FATAL_ERROR "LVGL lodepng info definition was not found")
endif()
string(SUBSTRING "${LVW_PNG_CODE}" ${begin} ${length} info)
lvw_png_replace("${info}" [=[static lv_result_t decoder_info(lv_image_decoder_t * decoder, const void * src, lv_image_header_t * header)
{
    LV_UNUSED(decoder);
    const uint8_t * data;
    size_t length;
    uint8_t prefix[33];
    lv_image_src_t type = lv_image_src_get_type(src);
    if(type == LV_IMAGE_SRC_FILE) {
        if(lv_strcmp(lv_fs_get_ext(src), "png") != 0) return LV_RESULT_INVALID;
        lv_fs_file_t file;
        if(lv_fs_open(&file, src, LV_FS_MODE_RD) != LV_FS_RES_OK) return LV_RESULT_INVALID;
        uint32_t read = 0;
        lv_fs_res_t result = lv_fs_read(&file, prefix, sizeof(prefix), &read);
        lv_fs_close(&file);
        if(result != LV_FS_RES_OK || read != sizeof(prefix)) return LV_RESULT_INVALID;
        data = prefix;
        length = sizeof(prefix);
    }
    else if(type == LV_IMAGE_SRC_VARIABLE) {
        const lv_image_dsc_t * image = src;
        data = image->data;
        length = image->data_size;
    }
    else return LV_RESULT_INVALID;

    LodePNGState state;
    lodepng_state_init(&state);
    unsigned width, height;
    unsigned error = lodepng_inspect(&width, &height, &state, data, length);
    lodepng_state_cleanup(&state);
    if(error) return LV_RESULT_INVALID;
    header->cf = LV_COLOR_FORMAT_ARGB8888;
    header->w = width;
    header->h = height;
    return LV_RESULT_OK;
}

]=])
lvw_png_replace([=[    if(entry == NULL) {
        return LV_RESULT_INVALID;
    }
]=] [=[    if(entry == NULL) {
        lv_draw_buf_destroy(decoded);
        dsc->decoded = NULL;
        return LV_RESULT_INVALID;
    }
]=])
set(LVW_PNG_DECODER_CODE "${LVW_PNG_CODE}")

file(READ "${LVW_PNG_LIBRARY}" LVW_PNG_CODE)
lvw_png_replace("    if(width == 0 || height == 0) CERROR_RETURN_ERROR(state->error, 93);"
    "    if(width == 0 || height == 0 || width > 16383 || height > 65535\n       || lv_draw_buf_width_to_stride(width, LV_COLOR_FORMAT_ARGB8888) > 65535) CERROR_RETURN_ERROR(state->error, 93);\n    if(info->color.bitdepth > 8) CERROR_RETURN_ERROR(state->error, 116);")
lvw_png_replace("        case 113:\n            return \"ICC profile unreasonably large\";"
    "        case 113:\n            return \"ICC profile unreasonably large\";\n        case 116:\n            return \"bit depth above 8 is unsupported by the LVGL draw buffer\";")
set(LVW_PNG_LIBRARY_CODE "${LVW_PNG_CODE}")

file(READ "${LVW_PNG_BINARY}" LVW_PNG_CODE)
lvw_png_replace("    /*For backward compatibility, all images are not premultiplied for now.*/"
    "    if(header->cf == LV_COLOR_FORMAT_RAW || header->cf == LV_COLOR_FORMAT_RAW_ALPHA) return LV_RESULT_INVALID;\n\n    /*For backward compatibility, all images are not premultiplied for now.*/")
set(LVW_PNG_BINARY_CODE "${LVW_PNG_CODE}")

file(READ "${LVW_PNG_CACHE}" LVW_PNG_CODE)
lvw_png_replace("void lv_image_cache_drop(const void * src)\n{"
    [=[void lv_image_cache_drop(const void * src)
{
#if LV_IMAGE_HEADER_CACHE_DEF_CNT > 0
    lv_cache_t * headers = LV_GLOBAL_DEFAULT()->img_header_cache;
    if(src == NULL) lv_cache_drop_all(headers, NULL);
    else {
        lv_image_header_cache_data_t key = { .src_type = lv_image_src_get_type(src), .src = src };
        lv_cache_drop(headers, &key, NULL);
    }
#endif]=])
set(LVW_PNG_CACHE_CODE "${LVW_PNG_CODE}")

foreach(kind DECODER LIBRARY BINARY CACHE)
    set(source "${LVW_PNG_${kind}}")
    get_filename_component(filename "${source}" NAME)
    set(adapted "${LVW_PNG_OUTPUT}/${filename}")
    set(code "${LVW_PNG_${kind}_CODE}")
    file(CONFIGURE OUTPUT "${adapted}" CONTENT "/* Adapted by liblvgl-wasm: validate PNG inputs and release failed decodes. */\n${code}" @ONLY)
    get_target_property(sources lvgl SOURCES)
    list(FIND sources "${source}" index)
    list(LENGTH sources before)
    list(REMOVE_ITEM sources "${source}")
    list(LENGTH sources after)
    math(EXPR removed "${before} - ${after}")
    if(NOT removed EQUAL 1)
        message(FATAL_ERROR "Expected one LVGL PNG compilation unit: ${source}")
    endif()
    list(INSERT sources ${index} "${adapted}")
    set_property(TARGET lvgl PROPERTY SOURCES "${sources}")
    get_filename_component(directory "${source}" DIRECTORY)
    set_source_files_properties("${adapted}" TARGET_DIRECTORY lvgl
        PROPERTIES INCLUDE_DIRECTORIES "${directory}")
endforeach()
