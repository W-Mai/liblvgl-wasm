cmake_minimum_required(VERSION 3.25)
project(lvgl_native_example LANGUAGES C CXX)
find_package(liblvgl-wasm CONFIG REQUIRED)
lvw_add_reactor(lvgl_native_example direct_api.c)
