cmake_minimum_required(VERSION 3.25)
project(liblvgl_wasm VERSION 0.1.0 LANGUAGES C CXX ASM)

include(FetchContent)

add_library(lvw_wasm_sjlj INTERFACE)
target_compile_options(lvw_wasm_sjlj INTERFACE
    "SHELL:-mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false"
    "$<$<COMPILE_LANGUAGE:CXX>:-fwasm-exceptions>")
target_link_options(lvw_wasm_sjlj INTERFACE -fwasm-exceptions)
target_link_libraries(lvw_wasm_sjlj INTERFACE setjmp unwind)

set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_USE_THORVG ON CACHE BOOL "" FORCE)
set(CONFIG_LV_USE_THORVG_INTERNAL ON CACHE BOOL "" FORCE)
set(LV_BUILD_INSTALL OFF CACHE BOOL "" FORCE)
set(LV_BUILD_CONF_PATH "${CMAKE_CURRENT_SOURCE_DIR}/config/lv_conf.h" CACHE FILEPATH "" FORCE)
set(LV_USE_FIND_PACKAGE OFF CACHE BOOL "" FORCE)
set(LV_USE_PKG_CONFIG OFF CACHE BOOL "" FORCE)
set(LV_FETCH_DEPENDENCIES OFF CACHE BOOL "" FORCE)

FetchContent_Declare(lvgl
    URL
        https://github.com/lvgl/lvgl/releases/download/v9.6.0/lvgl-v9.6.0-lite.zip
        https://api.github.com/repos/lvgl/lvgl/releases/assets/568163200
    URL_HASH SHA256=3cbb7ddbedeb1672ad04908afe8ae290561d625d9307ea6a875d3863dae348ae
    HTTP_HEADER "Accept: application/octet-stream"
    DOWNLOAD_NAME lvgl-v9.6.0-lite.zip
    DOWNLOAD_EXTRACT_TIMESTAMP FALSE
    TLS_VERIFY ON
)
FetchContent_MakeAvailable(lvgl)
target_compile_options(lvgl_thorvg PRIVATE
    "SHELL:-include \"${CMAKE_CURRENT_SOURCE_DIR}/config/lvw_thorvg.h\"")
target_link_libraries(lvgl_thorvg PRIVATE lvw_wasm_sjlj)
include(cmake/freetype.cmake)
include(cmake/observer.cmake)
include(cmake/decoder.cmake)
include(cmake/gif.cmake)
include(cmake/outline.cmake)
include(cmake/svg.cmake)
include(cmake/lottie.cmake)

add_executable(liblvgl bridge/lvw.c)
if(EXISTS "${CMAKE_BINARY_DIR}/api-shims.c")
    target_sources(liblvgl PRIVATE "${CMAKE_BINARY_DIR}/api-shims.c")
endif()
target_compile_features(liblvgl PRIVATE c_std_11)
target_include_directories(liblvgl PUBLIC bridge PRIVATE "${lvgl_SOURCE_DIR}/src")
target_link_libraries(liblvgl PRIVATE lvgl::lvgl)
target_compile_options(liblvgl PRIVATE -Wall -Wextra -Werror)

add_executable(liblvgl_c_demo EXCLUDE_FROM_ALL bridge/lvw.c examples/c/direct_api.c)
target_compile_features(liblvgl_c_demo PRIVATE c_std_11)
target_include_directories(liblvgl_c_demo PRIVATE bridge "${lvgl_SOURCE_DIR}/src")
target_link_libraries(liblvgl_c_demo PRIVATE lvgl::lvgl)
target_compile_options(liblvgl_c_demo PRIVATE -Wall -Wextra -Werror)

if(CMAKE_SYSTEM_NAME STREQUAL "WASI")
    set_target_properties(liblvgl PROPERTIES OUTPUT_NAME liblvgl SUFFIX .wasm)
    target_link_options(liblvgl PRIVATE
        -mexec-model=reactor
        -Wl,--no-entry
        -Wl,--export-memory
        -Wl,--export-table
        -Wl,--growable-table
        -Wl,--max-memory=268435456
    )
    if(EXISTS "${CMAKE_BINARY_DIR}/api-exports.txt")
        file(STRINGS "${CMAKE_BINARY_DIR}/api-exports.txt" LVW_EXPORT_FLAGS)
        target_link_options(liblvgl PRIVATE ${LVW_EXPORT_FLAGS})
    endif()

    set_target_properties(liblvgl_c_demo PROPERTIES
        OUTPUT_NAME liblvgl-c-demo SUFFIX .wasm
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/examples/c")
    target_link_options(liblvgl_c_demo PRIVATE
        -mexec-model=reactor
        -Wl,--no-entry
        -Wl,--export-memory
        -Wl,--export-table
        -Wl,--growable-table
        -Wl,--max-memory=268435456
    )
endif()
