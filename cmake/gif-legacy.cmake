# Legacy GIF widget and gifdec share the selected source's public layouts.
set(LVW_GIF_DECODER "${LVW_GIF_DIRECTORY}/gifdec.c")
set(LVW_GIF_DECODER_ADAPTED "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/gifdec.c")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LVW_GIF_DECODER}")
file(SHA256 "${LVW_GIF_DECODER}" decoder_hash)
if(NOT decoder_hash STREQUAL "225467155fb3aebab9b75ba45f01b390c19f2551ba4566f69ed7aa117301d8db")
    file(REMOVE "${LVW_GIF_ADAPTED}" "${LVW_GIF_DECODER_ADAPTED}")
    message(FATAL_ERROR "Unsupported LVGL GIF source: ${LVW_GIF_DECODER}")
endif()
if(LVW_GIF_ADAPT_CACHE)
    include("${CMAKE_CURRENT_LIST_DIR}/image-cache.cmake")
endif()

lvw_gif_replace("    /*Close previous gif if any*/" [=[    lv_timer_pause(gifobj->timer);
    lv_image_cache_drop(lv_image_get_src(obj));
    lv_image_set_src(obj, NULL);
    /*Close previous gif if any*/]=])
lvw_gif_replace("        lv_image_cache_drop(lv_image_get_src(obj));\n\n" "")
lvw_gif_replace("    if(lv_image_src_get_type(src) == LV_IMAGE_SRC_VARIABLE) {"
    "    if(src == NULL) return;\n    if(lv_image_src_get_type(src) == LV_IMAGE_SRC_VARIABLE) {")
lvw_gif_replace("    gifobj->imgdsc.header.w = gifobj->gif->width;"
    "    gifobj->imgdsc.header.w = gifobj->gif->width;\n    gifobj->imgdsc.header.stride = gifobj->gif->width * 4;\n    gifobj->imgdsc.data_size = (uint32_t)gifobj->gif->width * gifobj->gif->height * 4;")
lvw_gif_replace([=[    uint32_t elaps = lv_tick_elaps(gifobj->last_call);
    if(elaps < gifobj->gif->gce.delay * 10) return;
]=] [=[    if(gifobj->gif == NULL) {
        lv_timer_pause(t);
        return;
    }
]=])
lvw_gif_replace([=[    if(has_next == 0) {
        /*It was the last repeat*/
        lv_result_t res = lv_obj_send_event(obj, LV_EVENT_READY, NULL);
        lv_timer_pause(t);
        if(res != LV_FS_RES_OK) return;
    }
]=] [=[    if(has_next < 0) {
        lv_gif_set_src(obj, NULL);
        return;
    }
    if(has_next == 0) {
        lv_timer_pause(t);
        lv_obj_send_event(obj, LV_EVENT_READY, NULL);
        return;
    }
    uint32_t delay = gifobj->gif->gce.delay * 10;
    lv_timer_set_period(t, delay ? delay : 10);
]=])
set(LVW_GIF_WIDGET_CODE "${LVW_GIF_CODE}")

file(READ "${LVW_GIF_DECODER}" LVW_GIF_CODE)
lvw_gif_replace("    /* Create gd_GIF Structure. */" [=[    if(width == 0 || height == 0 || width > 16383 || bgidx >= gct_sz) goto fail;
    size_t pixels = (size_t)width * height;
    size_t extra = 0;
#if LV_GIF_CACHE_DECODE_DATA
    extra = LZW_CACHE_SIZE;
#endif
    if(pixels > (SIZE_MAX - sizeof(gd_GIF) - extra) / 5) goto fail;
    /* Create gd_GIF Structure. */]=])
lvw_gif_replace([=[#if LV_GIF_CACHE_DECODE_DATA
    gif = lv_malloc(sizeof(gd_GIF) + 5 * width * height + LZW_CACHE_SIZE);
    #else
    gif = lv_malloc(sizeof(gd_GIF) + 5 * width * height);
    #endif]=] "    gif = lv_malloc(sizeof(gd_GIF) + 5 * pixels + extra);")
lvw_gif_replace("    f_gif_read(gif, &fisrz, 1);" [=[    if(gif->fw == 0 || gif->fh == 0 || gif->fx >= gif->width || gif->fy >= gif->height
       || gif->fw > gif->width - gif->fx || gif->fh > gif->height - gif->fy) return -1;
    f_gif_read(gif, &fisrz, 1);]=])
lvw_gif_replace("    key_size = (int) byte;\n    clear_code = 1 << key_size;"
    "    key_size = (int) byte;\n    if(key_size < 2 || key_size > 8) return -1;\n    clear_code = 1 << key_size;")
lvw_gif_replace("    key_size = (int) byte;\n    start = f_gif_seek(gif, 0, LV_FS_SEEK_CUR);"
    "    key_size = (int) byte;\n    if(key_size < 2 || key_size > 8) return -1;\n    start = f_gif_seek(gif, 0, LV_FS_SEEK_CUR);")
lvw_gif_replace("    table = new_table(key_size);" "    table = new_table(key_size);\n    if(table == NULL) return -1;")
lvw_gif_replace("        entry = table->entries[key];\n        str_len = entry.length;" [=[        if(key >= table->nentries) {
            lv_free(table);
            return -1;
        }
        entry = table->entries[key];
        str_len = entry.length;
        if(str_len == 0 || str_len > frm_size - frm_off) {
            lv_free(table);
            return -1;
        }]=])
lvw_gif_replace("        while (sp > p_stack) {\n            *ptr++ = *(--sp);"
    "        while (sp > p_stack) {\n            if(frm_off >= frm_size) return -1;\n            *ptr++ = *(--sp);")
lvw_gif_replace("        while (curr_code >= new_codes) {\n            *sp++ = p_suffix[curr_code];"
    "        while (curr_code >= new_codes) {\n            if(curr_code >= slot || sp >= p_stack + LZW_TABLE_SIZE - 1) return -1;\n            *sp++ = p_suffix[curr_code];")
lvw_gif_replace("    f_gif_seek(gif, end, LV_FS_SEEK_SET);\n    return ret;"
    "    f_gif_seek(gif, end, LV_FS_SEEK_SET);\n    return frm_off == frm_size ? ret : -1;")
lvw_gif_replace("    f_gif_seek(gif, end, LV_FS_SEEK_SET);\n    return 0;"
    "    f_gif_seek(gif, end, LV_FS_SEEK_SET);\n    return frm_off == frm_size ? 0 : -1;")

# Dispose the previous frame only after finding another image, not at the trailer.
lvw_gif_replace("    dispose(gif);\n    f_gif_read(gif, &sep, 1);"
    "    gd_GCE previous = gif->gce;\n    f_gif_read(gif, &sep, 1);")
lvw_gif_replace("    if(read_image(gif) == -1)" [=[    gd_GCE current = gif->gce;
    if(gif->fw == 0 && gif->fh == 0) {
        const uint8_t * background = &gif->gct.colors[gif->bgindex * 3];
        for(size_t i = 0; i < (size_t)gif->width * gif->height; i++) {
            gif->canvas[4 * i] = background[2];
            gif->canvas[4 * i + 1] = background[1];
            gif->canvas[4 * i + 2] = background[0];
            gif->canvas[4 * i + 3] = current.transparency ? 0 : 255;
        }
        memset(gif->frame, gif->bgindex, (size_t)gif->width * gif->height);
    }
    else {
        gif->gce = previous;
        dispose(gif);
        gif->gce = current;
    }
    if(read_image(gif) == -1)]=])
lvw_gif_replace("    gif->loop_count = -1;\n    f_gif_seek(gif, gif->anim_start, LV_FS_SEEK_SET);" [=[    gif->loop_count = -1;
    gif->fx = gif->fy = gif->fw = gif->fh = 0;
    memset(&gif->gce, 0, sizeof(gif->gce));
    gif->palette = &gif->gct;
    f_gif_seek(gif, gif->anim_start, LV_FS_SEEK_SET);]=])
lvw_gif_replace("        lv_fs_read(&gif->fd, buf, len, NULL);"
    "        memset(buf, 0, len);\n        lv_fs_read(&gif->fd, buf, len, NULL);")
lvw_gif_replace("        uint32_t x;" "        uint32_t x = 0;")

file(CONFIGURE OUTPUT "${LVW_GIF_DECODER_ADAPTED}"
    CONTENT "/* Adapted by liblvgl-wasm: bound GIF output and preserve frame disposal. */\n${LVW_GIF_CODE}" @ONLY)
get_target_property(sources lvgl SOURCES)
list(FIND sources "${LVW_GIF_DECODER}" index)
if(index LESS 0)
    message(FATAL_ERROR "Expected LVGL gifdec compilation unit")
endif()
list(REMOVE_ITEM sources "${LVW_GIF_DECODER}")
list(INSERT sources ${index} "${LVW_GIF_DECODER_ADAPTED}")
set_property(TARGET lvgl PROPERTY SOURCES "${sources}")
set_source_files_properties("${LVW_GIF_DECODER_ADAPTED}" TARGET_DIRECTORY lvgl
    PROPERTIES INCLUDE_DIRECTORIES "${LVW_GIF_DIRECTORY}")
set(LVW_GIF_CODE "/* Adapted by liblvgl-wasm: preserve GIF deadlines and callback lifetimes. */\n${LVW_GIF_WIDGET_CODE}")
