# Export the configured native libraries and their public compile interfaces.
if(NOT CMAKE_SYSTEM_NAME STREQUAL "WASI" OR
   NOT EXISTS "${CMAKE_BINARY_DIR}/api-shims.c")
    return()
endif()

include(CMakePackageConfigHelpers)

add_library(lvw_bridge STATIC EXCLUDE_FROM_ALL "${PROJECT_SOURCE_DIR}/bridge/lvw.c")
target_include_directories(lvw_bridge PUBLIC
    "$<BUILD_INTERFACE:${PROJECT_SOURCE_DIR}/bridge>" "$<INSTALL_INTERFACE:include>"
    PRIVATE "${lvgl_SOURCE_DIR}/src")
target_link_libraries(lvw_bridge PUBLIC lvgl lvw_wasm_sjlj)
set_target_properties(lvw_bridge PROPERTIES EXPORT_NAME bridge)

add_library(lvw_shims STATIC EXCLUDE_FROM_ALL "${CMAKE_BINARY_DIR}/api-shims.c")
target_link_libraries(lvw_shims PUBLIC lvgl lvw_wasm_sjlj)
set_target_properties(lvw_shims PROPERTIES EXPORT_NAME shims)

foreach(target lvw_bridge lvw_shims)
    target_compile_features(${target} PRIVATE c_std_11)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Werror)
endforeach()
target_compile_definitions(lvgl INTERFACE "$<INSTALL_INTERFACE:LV_CONF_INCLUDE_SIMPLE>")
set_target_properties(lvw_wasm_sjlj PROPERTIES EXPORT_NAME wasm_sjlj)
set_target_properties(lvgl_thorvg PROPERTIES EXPORT_NAME thorvg)
add_custom_target(lvw_ndk DEPENDS lvw_bridge lvw_shims)

install(TARGETS lvgl lvgl_thorvg freetype lvw_wasm_sjlj lvw_bridge lvw_shims
    EXPORT liblvgl-wasmTargets ARCHIVE DESTINATION lib COMPONENT ndk)
install(EXPORT liblvgl-wasmTargets NAMESPACE lvw::
    DESTINATION lib/cmake/liblvgl-wasm COMPONENT ndk)

install(DIRECTORY "${lvgl_SOURCE_DIR}/include/lvgl" DESTINATION include COMPONENT ndk)
install(FILES "${PROJECT_SOURCE_DIR}/config/lv_conf.h"
    DESTINATION include/lvgl/config COMPONENT ndk)
install(FILES "${PROJECT_SOURCE_DIR}/bridge/lvw.h" "${PROJECT_SOURCE_DIR}/config/lvw_freetype.h"
    DESTINATION include COMPONENT ndk)
install(DIRECTORY "${freetype_SOURCE_DIR}/include/" DESTINATION include/freetype2 COMPONENT ndk
    FILES_MATCHING PATTERN "*.h" PATTERN "internal" EXCLUDE)
install(DIRECTORY "${freetype_BINARY_DIR}/include/" DESTINATION include/freetype2 COMPONENT ndk
    FILES_MATCHING PATTERN "*.h")

set(LVW_NDK_DATA_DIR share/liblvgl-wasm)
install(FILES "${CMAKE_BINARY_DIR}/api.json" "${CMAKE_BINARY_DIR}/api-exports.txt"
    DESTINATION "${LVW_NDK_DATA_DIR}/metadata" COMPONENT ndk)
install(DIRECTORY "${PROJECT_SOURCE_DIR}/generator/"
    DESTINATION "${LVW_NDK_DATA_DIR}/generator" COMPONENT ndk FILES_MATCHING PATTERN "*.py")
install(DIRECTORY "${PROJECT_SOURCE_DIR}/config/"
    DESTINATION "${LVW_NDK_DATA_DIR}/config" COMPONENT ndk FILES_MATCHING PATTERN "*.h")
install(FILES "${PROJECT_SOURCE_DIR}/examples/c/CMakeLists.txt"
    "${PROJECT_SOURCE_DIR}/examples/c/direct_api.c"
    DESTINATION examples/c COMPONENT ndk)
install(DIRECTORY "${PROJECT_SOURCE_DIR}/third_party/freetype" "${PROJECT_SOURCE_DIR}/third_party/thorvg"
    DESTINATION "${LVW_NDK_DATA_DIR}/licenses" COMPONENT ndk)
install(FILES "${lvgl_SOURCE_DIR}/LICENCE.txt"
    DESTINATION "${LVW_NDK_DATA_DIR}/licenses/lvgl" COMPONENT ndk)

configure_package_config_file("${PROJECT_SOURCE_DIR}/cmake/liblvgl-wasmConfig.cmake.in"
    "${CMAKE_BINARY_DIR}/liblvgl-wasmConfig.cmake"
    INSTALL_DESTINATION lib/cmake/liblvgl-wasm PATH_VARS LVW_NDK_DATA_DIR)
write_basic_package_version_file("${CMAKE_BINARY_DIR}/liblvgl-wasmConfigVersion.cmake"
    VERSION "${PROJECT_VERSION}" COMPATIBILITY ExactVersion)
install(FILES "${CMAKE_BINARY_DIR}/liblvgl-wasmConfig.cmake"
    "${CMAKE_BINARY_DIR}/liblvgl-wasmConfigVersion.cmake"
    DESTINATION lib/cmake/liblvgl-wasm COMPONENT ndk)
