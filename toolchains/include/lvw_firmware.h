#ifndef LVW_FIRMWARE_H
#define LVW_FIRMWARE_H

#include <stdint.h>

#define LVW_FIRMWARE_ABI_VERSION 1u
#define LVW_FIRMWARE_EXPORT(name) __attribute__((export_name(#name)))

#ifdef __cplusplus
extern "C" {
#endif

LVW_FIRMWARE_EXPORT(lvw_firmware_abi_version) uint32_t lvw_firmware_abi_version(void);
LVW_FIRMWARE_EXPORT(lvw_firmware_init) int32_t lvw_firmware_init(uint32_t width, uint32_t height);
LVW_FIRMWARE_EXPORT(lvw_firmware_step) int32_t lvw_firmware_step(uint32_t elapsed_ms);
LVW_FIRMWARE_EXPORT(lvw_firmware_frame_ptr) uint32_t lvw_firmware_frame_ptr(void);
LVW_FIRMWARE_EXPORT(lvw_firmware_frame_len) uint32_t lvw_firmware_frame_len(void);
LVW_FIRMWARE_EXPORT(lvw_firmware_pointer) void lvw_firmware_pointer(int32_t x, int32_t y, uint32_t pressed);
LVW_FIRMWARE_EXPORT(lvw_firmware_shutdown) void lvw_firmware_shutdown(void);

#ifdef __cplusplus
}
#endif

#endif
