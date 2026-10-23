# Export the configured native libraries and their public compile interfaces.
if(NOT CMAKE_SYSTEM_NAME STREQUAL "WASI" OR
   NOT EXISTS "${CMAKE_BINARY_DIR}/api-shims.c")
    return()
endif()

include(CMakePackageConfigHelpers)

add_library(lvw_bridge STATIC EXCLUDE_FROM_ALL "${PROJECT_SOURCE_DIR}/bridge/lvw.c")
target_include_directories(lvw_bridge PUBLIC
    "$<BUILD_INTERFACE:${PROJECT_SOURCE_DIR}/bridge>" "$<INSTALL_INTERFACE:include>"
    PRIVATE ${LVW_BRIDGE_INCLUDE_DIR})
target_compile_definitions(lvw_bridge PRIVATE ${LVW_BRIDGE_DEFINITIONS})
target_link_libraries(lvw_bridge PUBLIC lvgl lvw_wasm_sjlj)
set_target_properties(lvw_bridge PROPERTIES EXPORT_NAME bridge)

add_library(lvw_shims STATIC EXCLUDE_FROM_ALL "${CMAKE_BINARY_DIR}/api-shims.c")
target_link_libraries(lvw_shims PUBLIC lvgl lvw_wasm_sjlj)
set_target_properties(lvw_shims PROPERTIES EXPORT_NAME shims)

foreach(target lvw_bridge lvw_shims)
    target_compile_features(${target} PRIVATE c_std_11)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Werror)
endforeach()
# Installed consumers use the same public-header definitions as the generator.
get_target_property(LVW_BUILD_DEFINITIONS lvgl INTERFACE_COMPILE_DEFINITIONS)
set_property(TARGET lvgl PROPERTY INTERFACE_COMPILE_DEFINITIONS
    "$<BUILD_INTERFACE:${LVW_BUILD_DEFINITIONS}>"
    "$<INSTALL_INTERFACE:LV_CONF_INCLUDE_SIMPLE;LV_KCONFIG_IGNORE;LV_LVGL_H_INCLUDE_SIMPLE>")
# Older upstream targets expose absolute source directories in their public interface.
set_property(TARGET lvgl PROPERTY INTERFACE_INCLUDE_DIRECTORIES
    "$<BUILD_INTERFACE:${lvgl_SOURCE_DIR}>" "$<BUILD_INTERFACE:${lvgl_SOURCE_DIR}/include>"
    "$<BUILD_INTERFACE:${LVW_CONF_DIR}>" "$<INSTALL_INTERFACE:include>"
    "$<INSTALL_INTERFACE:include/lvgl>" "$<INSTALL_INTERFACE:include/lvgl/config>")
set_property(TARGET lvgl PROPERTY INTERFACE_SYSTEM_INCLUDE_DIRECTORIES
    "$<BUILD_INTERFACE:${lvgl_SOURCE_DIR}>")
set_target_properties(lvw_wasm_sjlj PROPERTIES EXPORT_NAME wasm_sjlj)
add_custom_target(lvw_ndk DEPENDS lvw_bridge lvw_shims)

set(LVW_NDK_TARGETS lvgl lvw_wasm_sjlj lvw_bridge lvw_shims)
if(LV_USE_THORVG OR LV_USE_THORVG_INTERNAL)
    set_target_properties(lvgl_thorvg PROPERTIES EXPORT_NAME thorvg)
    list(APPEND LVW_NDK_TARGETS lvgl_thorvg)
endif()
if(LV_USE_FREETYPE)
    list(APPEND LVW_NDK_TARGETS freetype)
endif()
install(TARGETS ${LVW_NDK_TARGETS}
    EXPORT liblvgl-wasmTargets ARCHIVE DESTINATION lib COMPONENT ndk)
install(EXPORT liblvgl-wasmTargets NAMESPACE lvw::
    DESTINATION lib/cmake/liblvgl-wasm COMPONENT ndk)

if(LVW_HEADER_LAYOUT STREQUAL "include/lvgl")
    install(DIRECTORY "${lvgl_SOURCE_DIR}/include/lvgl" DESTINATION include COMPONENT ndk)
else()
    install(FILES "${lvgl_SOURCE_DIR}/lvgl.h" DESTINATION include/lvgl COMPONENT ndk)
    if(EXISTS "${lvgl_SOURCE_DIR}/lv_version.h")
        install(FILES "${lvgl_SOURCE_DIR}/lv_version.h" DESTINATION include/lvgl COMPONENT ndk)
    endif()
    install(DIRECTORY "${lvgl_SOURCE_DIR}/src" DESTINATION include/lvgl COMPONENT ndk
        FILES_MATCHING PATTERN "*.h")
endif()
install(FILES "${LVW_CONF_PATH}"
    DESTINATION include/lvgl/config COMPONENT ndk)
install(FILES "${PROJECT_SOURCE_DIR}/bridge/lvw.h" DESTINATION include COMPONENT ndk)
if(LV_USE_FREETYPE)
    install(FILES "${PROJECT_SOURCE_DIR}/config/lvw_freetype.h" DESTINATION include COMPONENT ndk)
    install(DIRECTORY "${freetype_SOURCE_DIR}/include/" DESTINATION include/freetype2 COMPONENT ndk
        FILES_MATCHING PATTERN "*.h" PATTERN "internal" EXCLUDE)
    install(DIRECTORY "${freetype_BINARY_DIR}/include/" DESTINATION include/freetype2 COMPONENT ndk
        FILES_MATCHING PATTERN "*.h")
endif()

set(LVW_NDK_DATA_DIR share/liblvgl-wasm)
install(FILES "${CMAKE_BINARY_DIR}/api.json" "${CMAKE_BINARY_DIR}/api-exports.txt"
    DESTINATION "${LVW_NDK_DATA_DIR}/metadata" COMPONENT ndk)
install(DIRECTORY "${PROJECT_SOURCE_DIR}/generator/"
    DESTINATION "${LVW_NDK_DATA_DIR}/generator" COMPONENT ndk FILES_MATCHING PATTERN "*.py")
install(FILES "${LVW_CONF_PATH}" DESTINATION "${LVW_NDK_DATA_DIR}/config" COMPONENT ndk)
install(FILES "${PROJECT_SOURCE_DIR}/examples/c/CMakeLists.txt"
    "${PROJECT_SOURCE_DIR}/examples/c/direct_api.c"
    DESTINATION examples/c COMPONENT ndk)
install(FILES "${PROJECT_SOURCE_DIR}/examples/zig/CMakeLists.txt"
    "${PROJECT_SOURCE_DIR}/examples/zig/direct_api.zig"
    DESTINATION examples/zig COMPONENT ndk)
install(FILES "${PROJECT_SOURCE_DIR}/cmake/zig.cmake"
    DESTINATION lib/cmake/liblvgl-wasm COMPONENT ndk)
if(LV_USE_FREETYPE)
    install(DIRECTORY "${PROJECT_SOURCE_DIR}/third_party/freetype"
        DESTINATION "${LVW_NDK_DATA_DIR}/licenses" COMPONENT ndk)
endif()
if(LV_USE_THORVG OR LV_USE_THORVG_INTERNAL)
    install(DIRECTORY "${PROJECT_SOURCE_DIR}/third_party/thorvg"
        DESTINATION "${LVW_NDK_DATA_DIR}/licenses" COMPONENT ndk)
endif()
install(DIRECTORY "${PROJECT_SOURCE_DIR}/third_party/runtime"
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
