#ifndef LVW_H
#define LVW_H

#include <stdint.h>

#define LVW_ABI_VERSION 1u
#define LVW_PIXEL_XRGB8888 1u
#define LVW_INPUT_POINTER 1u
#define LVW_INPUT_KEYPAD 2u
#define LVW_INPUT_ENCODER 4u
#define LVW_ANIM_PATH 1u
#define LVW_ANIM_GET_VALUE 2u
#define LVW_ANIM_START 4u
#define LVW_ANIM_COMPLETED 8u
#define LVW_ANIM_DELETED 16u
#define LVW_OBSERVER_MODE_TARGET 0u
#define LVW_OBSERVER_MODE_OBJECT 1u
#define LVW_DECODER_GET_AREA 1u
#define LVW_DECODER_CLOSE 2u
#define LVW_DECODER_PHASE_INFO 1u
#define LVW_DECODER_PHASE_OPEN 2u
#define LVW_DECODER_PHASE_AREA 3u
#define LVW_DECODER_PHASE_CLOSE 4u

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

typedef struct {
    uint32_t struct_size;
    uint32_t version;
    uint32_t src;
    uint32_t src_type;
    uint32_t header;
    uint32_t decoded;
    uint32_t palette;
    uint32_t palette_size;
    uint32_t user_data;
    uint32_t decoder_user_data;
    uint32_t file;
    uint32_t args_flags;
    uint32_t time_to_open;
    uint32_t error_msg;
    uint32_t phase;
    uint32_t reserved;
} lvw_decoder_view_t;

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
int32_t lvw_event_remove(uint32_t object, uint32_t callback_id);
uint32_t lvw_event_clicked(void);
uint32_t lvw_event_delete(void);
/* Borrowed until the active synchronous event callback returns; zero outside an event. */
uint32_t lvw_event_current(void);
uint32_t lvw_timer_create(uint32_t period_ms, uint32_t user_data, uint32_t callback_id);
int32_t lvw_timer_delete(uint32_t timer, uint32_t callback_id);
uint32_t lvw_anim_start(uint32_t descriptor, uint32_t callback_id, uint32_t exec_slot,
                        uint32_t flags);
int32_t lvw_anim_delete(uint32_t animation, uint32_t callback_id);
void lvw_anim_exec(uint32_t exec_slot, uint32_t var, int32_t value);
uint32_t lvw_observer_create(uint32_t subject, uint32_t target, uint32_t user_data,
                             uint32_t callback_id, uint32_t mode);
int32_t lvw_observer_delete(uint32_t observer, uint32_t callback_id);
uint32_t lvw_decoder_create(uint32_t user_data, uint32_t callback_id, uint32_t flags);
int32_t lvw_decoder_delete(uint32_t decoder, uint32_t callback_id);
int32_t lvw_decoder_read(uint32_t decoder, uint32_t dsc, uint32_t output, uint32_t size);
int32_t lvw_decoder_write(uint32_t decoder, uint32_t dsc, uint32_t decoded,
                          uint32_t palette, uint32_t palette_size, uint32_t user_data,
                          uint32_t time_to_open, uint32_t error_msg);

#endif
