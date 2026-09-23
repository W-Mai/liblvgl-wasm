#ifndef LVW_H
#define LVW_H

#include <stdint.h>

#define LVW_ABI_VERSION 1u
#define LVW_PIXEL_XRGB8888 1u
#define LVW_INPUT_POINTER 1u
#define LVW_INPUT_KEYPAD 2u
#define LVW_INPUT_ENCODER 4u

typedef struct {
    uint32_t struct_size;
    uint32_t version;
    uint32_t type;
    int32_t x;
    int32_t y;
    uint32_t state;
    uint32_t key;
    int32_t encoder_delta;
} lvw_input_packet_t;

typedef struct {
    uint32_t x;
    uint32_t y;
    uint32_t width;
    uint32_t height;
} lvw_rect_t;

typedef struct {
    uint32_t struct_size;
    uint32_t version;
    uint32_t next_ms;
    uint32_t frames_changed;
} lvw_step_result_t;

typedef struct {
    uint32_t struct_size;
    uint32_t version;
    uint32_t pixels_ptr;
    uint32_t byte_length;
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    uint32_t pixel_format;
    uint32_t alpha_mode;
    uint32_t dirty_rects_ptr;
    uint32_t dirty_rects_count;
    uint32_t frame_id;
} lvw_frame_t;

uint32_t lvw_abi_version(void);
int32_t lvw_init(void);
int32_t lvw_shutdown(void);
uint32_t lvw_alloc(uint32_t bytes);
void lvw_free(uint32_t ptr);
uint32_t lvw_display_create(uint32_t width, uint32_t height, uint32_t pixel_format);
int32_t lvw_display_resize(uint32_t display, uint32_t width, uint32_t height);
int32_t lvw_display_destroy(uint32_t display);
uint32_t lvw_indev_create(uint32_t display, uint32_t type);
int32_t lvw_indev_push(uint32_t indev, uint32_t packet_ptr, uint32_t packet_size);
int32_t lvw_step(uint32_t elapsed_ms, uint32_t out_result_ptr);
int32_t lvw_frame_get(uint32_t display, uint32_t out_frame_ptr);
int32_t lvw_resource_put(uint32_t name_ptr, uint32_t name_len, uint32_t data_ptr, uint32_t data_len);
int32_t lvw_event_add(uint32_t object, uint32_t event_code, uint32_t callback_id);
uint32_t lvw_event_clicked(void);
uint32_t lvw_event_delete(void);

#endif
