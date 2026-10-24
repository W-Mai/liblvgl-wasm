# Adapt GIF timing and lifecycle without modifying the pinned source checkout.
set(LVW_GIF_SOURCE "${lvgl_SOURCE_DIR}/src/widgets/gif/lv_gif.c")
if(NOT EXISTS "${LVW_GIF_SOURCE}")
    set(LVW_GIF_SOURCE "${lvgl_SOURCE_DIR}/src/libs/gif/lv_gif.c")
endif()
get_filename_component(LVW_GIF_DIRECTORY "${LVW_GIF_SOURCE}" DIRECTORY)
set(LVW_GIF_ADAPTED "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/lv_gif.c")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LVW_GIF_SOURCE}")
file(SHA256 "${LVW_GIF_SOURCE}" LVW_GIF_HASH)
set(LVW_GIF_ADAPT_CACHE OFF)
if(LVW_GIF_HASH STREQUAL "bf4a9574dc18e332152a749d5eb5d40b1b27ae9ca063cb37d59e85dc5e28a567")
    set(LVW_GIF_LEGACY ON)
    set(LVW_GIF_ADAPT_CACHE ON)
elseif(LVW_GIF_HASH STREQUAL "7f7fa1904373488106f0cf0dfd517445597e1caef11dcccf26fca8de049740e8")
    set(LVW_GIF_LEGACY ON)
elseif(LVW_GIF_HASH STREQUAL "76ff0761c46af76e7c6af6d496171f783a58bf1b700f0a080f6377f0f9bc747a")
    set(LVW_GIF_LEGACY OFF)
else()
    file(REMOVE "${LVW_GIF_ADAPTED}" "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/gifdec.c")
    message(FATAL_ERROR "Unsupported LVGL GIF source: ${LVW_GIF_SOURCE}")
endif()
file(READ "${LVW_GIF_SOURCE}" LVW_GIF_CODE)

function(lvw_gif_replace before after)
    string(FIND "${LVW_GIF_CODE}" "${before}" LVW_FIRST)
    string(FIND "${LVW_GIF_CODE}" "${before}" LVW_LAST REVERSE)
    if(LVW_FIRST LESS 0 OR NOT LVW_FIRST EQUAL LVW_LAST)
        file(REMOVE "${LVW_GIF_ADAPTED}" "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/gifdec.c")
        message(FATAL_ERROR "LVGL GIF adaptation requires a unique source anchor")
    endif()
    string(REPLACE "${before}" "${after}" LVW_GIF_CODE "${LVW_GIF_CODE}")
    set(LVW_GIF_CODE "${LVW_GIF_CODE}" PARENT_SCOPE)
endfunction()

if(LVW_GIF_LEGACY)
    include("${CMAKE_CURRENT_LIST_DIR}/gif-legacy.cmake")
else()
lvw_gif_replace([=[    GIFINFO info;
    if(!GIF_getInfo(&gifobj->gif, &info)) {
]=] [=[    GIFIMAGE * gif = &gifobj->gif;
    int32_t position = gif->GIFFile.iPos;
    unsigned char file_buffer[sizeof(gif->ucFileBuf)];
    lv_memcpy(file_buffer, gif->ucFileBuf, sizeof(file_buffer));
    GIFINFO info;
    int valid = GIF_getInfo(gif, &info);
    int32_t restored = gif->pfnSeek(&gif->GIFFile, position);
    lv_memcpy(gif->ucFileBuf, file_buffer, sizeof(file_buffer));
    if(!valid || restored != position) {
]=])

lvw_gif_replace([=[    lv_image_set_src((lv_obj_t *) gifobj, NULL);

    lv_timer_resume(gifobj->timer);
    lv_timer_reset(gifobj->timer);
]=] [=[    lv_timer_pause(gifobj->timer);
    lv_image_set_src((lv_obj_t *) gifobj, NULL);
]=])

lvw_gif_replace([=[        lv_timer_set_period(gifobj->timer, ms_delay_next);
]=] "")
lvw_gif_replace([=[    LV_PROFILER_DECODER_END_TAG("GIF_playFrame");

    if(has_next <= 0) {
]=] [=[    LV_PROFILER_DECODER_END_TAG("GIF_playFrame");

    if(ms_delay_next > 0) lv_timer_set_period(t, (uint32_t)ms_delay_next);
    if(has_next <= 0) {
]=])

lvw_gif_replace([=[        lv_result_t res = lv_obj_send_event(obj, LV_EVENT_READY, NULL);
]=] "")
lvw_gif_replace([=[        if(res != LV_RESULT_OK) {
            LV_PROFILER_DECODER_END;
            return;
        }
]=] "")
lvw_gif_replace([=[    lv_draw_buf_flush_cache(gifobj->draw_buf, NULL);
    lv_image_cache_drop(lv_image_get_src(obj));
    lv_obj_invalidate(obj);

    LV_PROFILER_DECODER_END;
]=] [=[    lv_draw_buf_flush_cache(gifobj->draw_buf, NULL);
    lv_image_cache_drop(lv_image_get_src(obj));
    lv_obj_invalidate(obj);

    LV_PROFILER_DECODER_END;
    if(has_next <= 0) lv_obj_send_event(obj, LV_EVENT_READY, NULL);
]=])
endif()
file(CONFIGURE OUTPUT "${LVW_GIF_ADAPTED}" CONTENT "${LVW_GIF_CODE}" @ONLY)

get_target_property(LVW_LVGL_SOURCES lvgl SOURCES)
list(FIND LVW_LVGL_SOURCES "${LVW_GIF_SOURCE}" LVW_GIF_INDEX)
list(LENGTH LVW_LVGL_SOURCES LVW_BEFORE)
list(REMOVE_ITEM LVW_LVGL_SOURCES "${LVW_GIF_SOURCE}")
list(LENGTH LVW_LVGL_SOURCES LVW_AFTER)
math(EXPR LVW_REMOVED "${LVW_BEFORE} - ${LVW_AFTER}")
if(NOT LVW_REMOVED EQUAL 1)
    message(FATAL_ERROR "Expected one LVGL GIF compilation unit")
endif()
list(INSERT LVW_LVGL_SOURCES ${LVW_GIF_INDEX} "${LVW_GIF_ADAPTED}")
set_property(TARGET lvgl PROPERTY SOURCES "${LVW_LVGL_SOURCES}")
set_source_files_properties("${LVW_GIF_ADAPTED}" TARGET_DIRECTORY lvgl
    PROPERTIES INCLUDE_DIRECTORIES "${LVW_GIF_DIRECTORY}")
