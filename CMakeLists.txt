cmake_minimum_required(VERSION 3.25)
project(liblvgl_wasm VERSION 0.1.0 LANGUAGES C CXX ASM)

include(FetchContent)

set(LVGL_COMMIT 80ca777e37a2b176770726a02e07a6fb79ef0b39)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_USE_THORVG OFF CACHE BOOL "" FORCE)
set(LV_BUILD_INSTALL OFF CACHE BOOL "" FORCE)
set(LV_BUILD_CONF_PATH "${CMAKE_CURRENT_SOURCE_DIR}/config/lv_conf.h" CACHE FILEPATH "" FORCE)
set(LV_USE_FIND_PACKAGE OFF CACHE BOOL "" FORCE)
set(LV_USE_PKG_CONFIG OFF CACHE BOOL "" FORCE)
set(LV_FETCH_DEPENDENCIES OFF CACHE BOOL "" FORCE)

FetchContent_Declare(lvgl
    GIT_REPOSITORY https://github.com/lvgl/lvgl.git
    GIT_TAG ${LVGL_COMMIT}
)
FetchContent_MakeAvailable(lvgl)

add_executable(liblvgl bridge/lvw.c)
target_compile_features(liblvgl PRIVATE c_std_11)
target_include_directories(liblvgl PUBLIC bridge)
target_link_libraries(liblvgl PRIVATE lvgl::lvgl)
target_compile_options(liblvgl PRIVATE -Wall -Wextra -Werror)

add_executable(liblvgl_c_demo EXCLUDE_FROM_ALL bridge/lvw.c examples/c/direct_api.c)
target_compile_features(liblvgl_c_demo PRIVATE c_std_11)
target_include_directories(liblvgl_c_demo PRIVATE bridge)
target_link_libraries(liblvgl_c_demo PRIVATE lvgl::lvgl)
target_compile_options(liblvgl_c_demo PRIVATE -Wall -Wextra -Werror)

if(CMAKE_SYSTEM_NAME STREQUAL "WASI")
    set_target_properties(liblvgl PROPERTIES OUTPUT_NAME liblvgl SUFFIX .wasm)
    target_link_options(liblvgl PRIVATE
        -mexec-model=reactor
        -Wl,--no-entry
        -Wl,--export-memory
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
        -Wl,--max-memory=268435456
    )
endif()
