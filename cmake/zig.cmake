# Compile a Zig C-ABI object and link it with the configured native libraries.
function(lvw_add_zig_reactor target source)
    find_program(LVW_ZIG NAMES zig REQUIRED)
    execute_process(COMMAND "${LVW_ZIG}" version
        OUTPUT_VARIABLE version OUTPUT_STRIP_TRAILING_WHITESPACE
        RESULT_VARIABLE result)
    if(NOT result EQUAL 0 OR NOT version STREQUAL "0.15.2")
        message(FATAL_ERROR "liblvgl-wasm requires Zig 0.15.2; found ${version}")
    endif()

    get_filename_component(source "${source}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
    get_filename_component(compiler_dir "${CMAKE_CXX_COMPILER}" DIRECTORY)
    get_filename_component(sdk "${compiler_dir}/.." REALPATH)
    set(sysroot "${sdk}/share/wasi-sysroot")
    set(build "${CMAKE_CURRENT_BINARY_DIR}/${target}-zig")
    file(MAKE_DIRECTORY "${build}")
    file(WRITE "${build}/libc.txt"
        "include_dir=${sysroot}/include/wasm32-wasip1\n"
        "sys_include_dir=${sysroot}/include/wasm32-wasip1\n"
        "crt_dir=${sysroot}/lib/wasm32-wasip1\n"
        "msvc_lib_dir=\nkernel32_lib_dir=\ngcc_dir=\n")
    get_target_property(includes lvw::lvgl INTERFACE_INCLUDE_DIRECTORIES)
    get_target_property(definitions lvw::lvgl INTERFACE_COMPILE_DEFINITIONS)
    set(headers)
    foreach(include IN LISTS includes)
        file(GLOB_RECURSE entries CONFIGURE_DEPENDS "${include}/*.h")
        list(APPEND headers ${entries})
    endforeach()
    list(TRANSFORM includes PREPEND "-I")
    list(TRANSFORM definitions PREPEND "-D")
    set(object "${build}/app.o")
    add_custom_command(OUTPUT "${object}"
        COMMAND "${LVW_ZIG}" build-obj "${source}" -target wasm32-wasi -O ReleaseSafe -fstrip
            --cache-dir "${build}/cache" --global-cache-dir "${build}/global-cache"
            --libc "${build}/libc.txt" -lc -fno-compiler-rt -fno-stack-protector
            ${includes} ${definitions} "-femit-bin=${object}"
        DEPENDS "${source}" "${build}/libc.txt" ${headers} ${ARGN}
        VERBATIM COMMAND_EXPAND_LISTS)
    set_source_files_properties("${object}" PROPERTIES GENERATED TRUE EXTERNAL_OBJECT TRUE)
    lvw_add_reactor(${target} "${object}")
endfunction()
