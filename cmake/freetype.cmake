# Build the font engine with the same target toolchain as LVGL.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(SKIP_INSTALL_ALL ON CACHE BOOL "" FORCE)
foreach(dependency ZLIB BZIP2 PNG HARFBUZZ BROTLI)
    set(FT_DISABLE_${dependency} ON CACHE BOOL "" FORCE)
endforeach()
FetchContent_Declare(freetype
    URL https://download.savannah.gnu.org/releases/freetype/freetype-2.14.3.tar.xz
    URL_HASH SHA256=36bc4f1cc413335368ee656c42afca65c5a3987e8768cc28cf11ba775e785a5f
    DOWNLOAD_EXTRACT_TIMESTAMP FALSE
    TLS_VERIFY ON
)
FetchContent_MakeAvailable(freetype)

# LVGL supplies these allocator and stream functions through its W: resource FS.
get_target_property(LVW_FREETYPE_SOURCES freetype SOURCES)
set(LVW_FREETYPE_SYSTEM_SOURCES ${LVW_FREETYPE_SOURCES})
list(FILTER LVW_FREETYPE_SYSTEM_SOURCES INCLUDE REGEX "/ftsystem\\.c$")
list(LENGTH LVW_FREETYPE_SYSTEM_SOURCES LVW_FREETYPE_SYSTEM_COUNT)
if(NOT LVW_FREETYPE_SYSTEM_COUNT EQUAL 1)
    message(FATAL_ERROR "Expected one FreeType system compilation unit")
endif()
list(REMOVE_ITEM LVW_FREETYPE_SOURCES ${LVW_FREETYPE_SYSTEM_SOURCES})
set_property(TARGET freetype PROPERTY SOURCES "${LVW_FREETYPE_SOURCES}")
target_compile_definitions(freetype PUBLIC FT_CONFIG_OPTIONS_H="lvw_freetype.h")
target_include_directories(freetype PUBLIC
    "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/config>"
    "$<INSTALL_INTERFACE:include>")
target_link_libraries(freetype PUBLIC lvw_wasm_sjlj)
target_link_libraries(lvgl PRIVATE freetype)

# LVGL's port still uses the internal include aliases removed by FreeType.
set_source_files_properties("${lvgl_SOURCE_DIR}/src/font/freetype/lv_ftsystem.c"
    TARGET_DIRECTORY lvgl PROPERTIES COMPILE_DEFINITIONS
    "FT2_BUILD_LIBRARY;FT_INTERNAL_DEBUG_H=<freetype/internal/ftdebug.h>;FT_INTERNAL_STREAM_H=<freetype/internal/ftstream.h>")
