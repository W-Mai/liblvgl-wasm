# Release fallback draw data through the font that produced it.
set(LVW_FONT_SOURCE "${lvgl_SOURCE_DIR}/src/draw/lv_draw_label.c")
set(LVW_FONT_ADAPTED "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/lv_draw_label.c")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LVW_FONT_SOURCE}")
file(SHA256 "${LVW_FONT_SOURCE}" hash)
set(LVW_FONT_LEGACY_SOURCES
    "dc11b17f84070e32e6928ab5270345d84aec5531b0d7596d1958661a047fa06e"
    "c02d9125a7cf2cd5d7f349ccb86e176527327dd2d9aa54b8f7e52f46bdc2ad8c")
if(hash STREQUAL "4ff547b19931f4505126f0fc7db7e10e17b3e4944222cfaf0d34ade14f2eb3b7")
    file(REMOVE "${LVW_FONT_ADAPTED}")
    return()
elseif(NOT hash IN_LIST LVW_FONT_LEGACY_SOURCES)
    file(REMOVE "${LVW_FONT_ADAPTED}")
    message(FATAL_ERROR "Unsupported LVGL font source: ${LVW_FONT_SOURCE}")
endif()
file(READ "${LVW_FONT_SOURCE}" code)
set(before [=[    if(g.resolved_font && font->release_glyph) {
        font->release_glyph(font, &g);
]=])
set(after [=[    if(g.resolved_font && g.resolved_font->release_glyph) {
        g.resolved_font->release_glyph(g.resolved_font, &g);
]=])
string(FIND "${code}" "${before}" first)
string(FIND "${code}" "${before}" last REVERSE)
if(first LESS 0 OR NOT first EQUAL last)
    file(REMOVE "${LVW_FONT_ADAPTED}")
    message(FATAL_ERROR "LVGL font adaptation requires a unique source anchor")
endif()
string(REPLACE "${before}" "${after}" code "${code}")
file(CONFIGURE OUTPUT "${LVW_FONT_ADAPTED}" CONTENT "${code}" @ONLY)
get_target_property(sources lvgl SOURCES)
list(FIND sources "${LVW_FONT_SOURCE}" index)
if(index LESS 0)
    message(FATAL_ERROR "Expected LVGL font compilation unit: ${LVW_FONT_SOURCE}")
endif()
list(REMOVE_ITEM sources "${LVW_FONT_SOURCE}")
list(INSERT sources ${index} "${LVW_FONT_ADAPTED}")
set_property(TARGET lvgl PROPERTY SOURCES "${sources}")
set_source_files_properties("${LVW_FONT_ADAPTED}" TARGET_DIRECTORY lvgl
    PROPERTIES INCLUDE_DIRECTORIES "${lvgl_SOURCE_DIR}/src/draw")
