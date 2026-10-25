#include "lvw_firmware.h"

#define LVW_FIRMWARE_MAX_WIDTH 480u
#define LVW_FIRMWARE_MAX_HEIGHT 288u
#define LVW_FIRMWARE_MAX_PIXELS (LVW_FIRMWARE_MAX_WIDTH * LVW_FIRMWARE_MAX_HEIGHT)

static uint8_t frame[LVW_FIRMWARE_MAX_PIXELS * 4u];
static uint32_t frame_width;
static uint32_t frame_height;
static uint32_t elapsed;
static int32_t pointer_x;
static int32_t pointer_y;
static uint32_t pointer_pressed;

static void paint(void) {
    for (uint32_t y = 0; y < frame_height; y++) {
        for (uint32_t x = 0; x < frame_width; x++) {
            const uint32_t red = (x * 255u) / (frame_width ? frame_width : 1u);
            const uint32_t green = (y * 255u) / (frame_height ? frame_height : 1u);
            const uint32_t blue = (elapsed / 8u + x + y) & 0xffu;
            const uint32_t hit = pointer_pressed && x == (uint32_t)pointer_x && y == (uint32_t)pointer_y;
            const uint32_t offset = (y * frame_width + x) * 4u;
            frame[offset] = (uint8_t)red;
            frame[offset + 1u] = (uint8_t)green;
            frame[offset + 2u] = (uint8_t)(hit ? 255u : blue);
            frame[offset + 3u] = 0xffu;
        }
    }
}

uint32_t lvw_firmware_abi_version(void) { return LVW_FIRMWARE_ABI_VERSION; }

int32_t lvw_firmware_init(uint32_t width, uint32_t height) {
    if (width == 0 || height == 0 || width > LVW_FIRMWARE_MAX_WIDTH || height > LVW_FIRMWARE_MAX_HEIGHT) return -1;
    frame_width = width;
    frame_height = height;
    elapsed = 0;
    pointer_x = -1;
    pointer_y = -1;
    pointer_pressed = 0;
    paint();
    return 0;
}

int32_t lvw_firmware_step(uint32_t elapsed_ms) {
    if (frame_width == 0 || frame_height == 0) return 0;
    elapsed += elapsed_ms;
    paint();
    return 1;
}

uint32_t lvw_firmware_frame_ptr(void) { return (uint32_t)(uintptr_t)frame; }

uint32_t lvw_firmware_frame_len(void) { return frame_width * frame_height * 4u; }

void lvw_firmware_pointer(int32_t x, int32_t y, uint32_t pressed) {
    pointer_x = x;
    pointer_y = y;
    pointer_pressed = pressed != 0;
}

void lvw_firmware_shutdown(void) {
    frame_width = 0;
    frame_height = 0;
    pointer_pressed = 0;
}
