# The verified 9.0 image-cache API must invalidate both decoded and header entries.
include_guard(DIRECTORY)
set(LVW_IMAGE_CACHE_SOURCE "${lvgl_SOURCE_DIR}/src/misc/cache/lv_image_cache.c")
set(LVW_IMAGE_CACHE_ADAPTED "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/lv_image_cache.c")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LVW_IMAGE_CACHE_SOURCE}")
file(SHA256 "${LVW_IMAGE_CACHE_SOURCE}" cache_hash)
if(NOT cache_hash STREQUAL "11163cc5ac07aa7512ceff90c0c325f39262b9d484032e359ee43a13884a0fe7")
    file(REMOVE "${LVW_IMAGE_CACHE_ADAPTED}")
    message(FATAL_ERROR "Unsupported LVGL image-cache source: ${LVW_IMAGE_CACHE_SOURCE}")
endif()
file(READ "${LVW_IMAGE_CACHE_SOURCE}" code)
string(REPLACE "void lv_image_cache_drop(const void * src)\n{" [=[void lv_image_cache_drop(const void * src)
{
#if LV_IMAGE_HEADER_CACHE_DEF_CNT > 0
    lv_cache_t * headers = LV_GLOBAL_DEFAULT()->img_header_cache;
    if(src == NULL) lv_cache_drop_all(headers, NULL);
    else {
        lv_image_header_cache_data_t key = { .src_type = lv_image_src_get_type(src), .src = src };
        lv_cache_drop(headers, &key, NULL);
    }
#endif]=] code "${code}")
file(CONFIGURE OUTPUT "${LVW_IMAGE_CACHE_ADAPTED}"
    CONTENT "/* Adapted by liblvgl-wasm: invalidate decoded and header image caches. */\n${code}" @ONLY)
get_target_property(sources lvgl SOURCES)
list(FIND sources "${LVW_IMAGE_CACHE_SOURCE}" index)
if(index LESS 0)
    message(FATAL_ERROR "Expected LVGL image-cache compilation unit")
endif()
list(REMOVE_ITEM sources "${LVW_IMAGE_CACHE_SOURCE}")
list(INSERT sources ${index} "${LVW_IMAGE_CACHE_ADAPTED}")
set_property(TARGET lvgl PROPERTY SOURCES "${sources}")
get_filename_component(directory "${LVW_IMAGE_CACHE_SOURCE}" DIRECTORY)
set_source_files_properties("${LVW_IMAGE_CACHE_ADAPTED}" TARGET_DIRECTORY lvgl
    PROPERTIES INCLUDE_DIRECTORIES "${directory}")
