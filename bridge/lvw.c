#include "lvw.h"

#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "lvgl/lvgl.h"

#define LVW_EXPORT(name) __attribute__((export_name(#name)))
#define LVW_MAX_FRAME_BYTES (64u * 1024u * 1024u)
#define LVW_MAX_DIRTY_RECTS 32u
#define LVW_INPUT_QUEUE_LEN 32u
#define LVW_RESOURCE_NAME_LEN 127u

typedef struct lvw_display_node {
    lv_display_t *lvgl;
    uint8_t *pixels;
    uint32_t width;
    uint32_t height;
    uint32_t byte_length;
    uint32_t frame_id;
    uint32_t dirty_count;
    lvw_rect_t dirty[LVW_MAX_DIRTY_RECTS];
    struct lvw_display_node *next;
} lvw_display_node_t;

typedef struct lvw_indev_node {
    lv_indev_t *lvgl;
    lvw_display_node_t *display;
    uint32_t type;
    lvw_input_packet_t queue[LVW_INPUT_QUEUE_LEN];
    lvw_input_packet_t current;
    uint32_t head;
    uint32_t count;
    struct lvw_indev_node *next;
} lvw_indev_node_t;

typedef struct lvw_resource {
    char name[LVW_RESOURCE_NAME_LEN + 1u];
    uint8_t *data;
    uint32_t length;
    struct lvw_resource *next;
} lvw_resource_t;

typedef struct {
    lvw_resource_t *resource;
    uint32_t offset;
} lvw_file_t;

static lvw_display_node_t *displays;
static lvw_indev_node_t *indevs;
static lvw_resource_t *resources;
static lv_fs_drv_t resource_driver;
static uint32_t initialized;
static uint32_t running;
static uint32_t callback_depth;

__attribute__((import_module("lvw"), import_name("event")))
extern void lvw_host_event(uint32_t callback_id, uint32_t object, uint32_t code);

static uint32_t pointer_value(const void *pointer) {
    return (uint32_t)(uintptr_t)pointer;
}

static lvw_display_node_t *find_display(uint32_t handle) {
    for (lvw_display_node_t *node = displays; node; node = node->next) {
        if (pointer_value(node->lvgl) == handle) return node;
    }
    return NULL;
}

static lvw_indev_node_t *find_indev(uint32_t handle) {
    for (lvw_indev_node_t *node = indevs; node; node = node->next) {
        if (pointer_value(node->lvgl) == handle) return node;
    }
    return NULL;
}

static int32_t frame_size(uint32_t width, uint32_t height, uint32_t *size) {
    if (!width || !height || width > 4096u || height > 4096u) return -2;
    uint64_t bytes = (uint64_t)width * height * 4u;
    if (bytes > LVW_MAX_FRAME_BYTES) return -2;
    *size = (uint32_t)bytes;
    return 0;
}

static void flush_callback(lv_display_t *display, const lv_area_t *area, uint8_t *pixels) {
    (void)pixels;
    lvw_display_node_t *node = lv_display_get_user_data(display);
    if (node && area) {
        uint32_t left = (uint32_t)(area->x1 < 0 ? 0 : area->x1);
        uint32_t top = (uint32_t)(area->y1 < 0 ? 0 : area->y1);
        uint32_t right = (uint32_t)(area->x2 >= (int32_t)node->width ? node->width - 1u : area->x2);
        uint32_t bottom = (uint32_t)(area->y2 >= (int32_t)node->height ? node->height - 1u : area->y2);
        if (right >= left && bottom >= top) {
            if (node->dirty_count < LVW_MAX_DIRTY_RECTS) {
                lvw_rect_t *rect = &node->dirty[node->dirty_count++];
                *rect = (lvw_rect_t){left, top, right - left + 1u, bottom - top + 1u};
            } else {
                node->dirty[0] = (lvw_rect_t){0, 0, node->width, node->height};
                node->dirty_count = 1;
            }
            node->frame_id++;
        }
    }
    lv_display_flush_ready(display);
}

static void input_callback(lv_indev_t *indev, lv_indev_data_t *data) {
    lvw_indev_node_t *node = lv_indev_get_user_data(indev);
    if (!node) return;
    if (node->count) {
        node->current = node->queue[node->head];
        node->head = (node->head + 1u) % LVW_INPUT_QUEUE_LEN;
        node->count--;
    }
    data->state = node->current.state ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
    data->point.x = node->current.x;
    data->point.y = node->current.y;
    data->key = node->current.key;
    data->enc_diff = (int16_t)node->current.encoder_delta;
    data->timestamp = lv_tick_get();
    data->continue_reading = node->count != 0;
    node->current.encoder_delta = 0;
}

static void event_callback(lv_event_t *event) {
    uint32_t callback_id = pointer_value(lv_event_get_user_data(event));
    uint32_t object = pointer_value(lv_event_get_current_target_obj(event));
    callback_depth++;
    lvw_host_event(callback_id, object, (uint32_t)lv_event_get_code(event));
    callback_depth--;
}

static void *resource_open(lv_fs_drv_t *driver, const char *path, lv_fs_mode_t mode) {
    (void)driver;
    if (mode != LV_FS_MODE_RD || !path) return NULL;
    while (*path == '/') path++;
    for (lvw_resource_t *resource = resources; resource; resource = resource->next) {
        if (strcmp(resource->name, path) == 0) {
            lvw_file_t *file = malloc(sizeof(*file));
            if (!file) return NULL;
            *file = (lvw_file_t){resource, 0};
            return file;
        }
    }
    return NULL;
}

static lv_fs_res_t resource_close(lv_fs_drv_t *driver, void *file_pointer) {
    (void)driver;
    free(file_pointer);
    return LV_FS_RES_OK;
}

static lv_fs_res_t resource_read(lv_fs_drv_t *driver, void *file_pointer, void *buffer,
                                 uint32_t requested, uint32_t *read_count) {
    (void)driver;
    lvw_file_t *file = file_pointer;
    if (!file || !buffer || !read_count) return LV_FS_RES_INV_PARAM;
    uint32_t remaining = file->resource->length - file->offset;
    uint32_t count = requested < remaining ? requested : remaining;
    memcpy(buffer, file->resource->data + file->offset, count);
    file->offset += count;
    *read_count = count;
    return LV_FS_RES_OK;
}

static lv_fs_res_t resource_seek(lv_fs_drv_t *driver, void *file_pointer, uint32_t position,
                                 lv_fs_whence_t whence) {
    (void)driver;
    lvw_file_t *file = file_pointer;
    if (!file) return LV_FS_RES_INV_PARAM;
    uint64_t base = whence == LV_FS_SEEK_CUR ? file->offset :
                    whence == LV_FS_SEEK_END ? file->resource->length : 0;
    uint64_t result = base + position;
    if (result > file->resource->length) return LV_FS_RES_INV_PARAM;
    file->offset = (uint32_t)result;
    return LV_FS_RES_OK;
}

static lv_fs_res_t resource_tell(lv_fs_drv_t *driver, void *file_pointer, uint32_t *position) {
    (void)driver;
    if (!file_pointer || !position) return LV_FS_RES_INV_PARAM;
    *position = ((lvw_file_t *)file_pointer)->offset;
    return LV_FS_RES_OK;
}

LVW_EXPORT(lvw_abi_version) uint32_t lvw_abi_version(void) { return LVW_ABI_VERSION; }

LVW_EXPORT(lvw_init) int32_t lvw_init(void) {
    if (initialized || running) return -1;
    lv_init();
    lv_fs_drv_init(&resource_driver);
    resource_driver.letter = 'W';
    resource_driver.open_cb = resource_open;
    resource_driver.close_cb = resource_close;
    resource_driver.read_cb = resource_read;
    resource_driver.seek_cb = resource_seek;
    resource_driver.tell_cb = resource_tell;
    lv_fs_drv_register(&resource_driver);
    initialized = 1;
    return 0;
}

LVW_EXPORT(lvw_shutdown) int32_t lvw_shutdown(void) {
    if (!initialized || running || callback_depth) return -1;
    while (indevs) {
        lvw_indev_node_t *node = indevs;
        indevs = node->next;
        lv_indev_delete(node->lvgl);
        free(node);
    }
    while (displays) {
        lvw_display_node_t *node = displays;
        displays = node->next;
        lv_display_delete(node->lvgl);
        free(node->pixels);
        free(node);
    }
    lv_deinit();
    while (resources) {
        lvw_resource_t *resource = resources;
        resources = resource->next;
        free(resource->data);
        free(resource);
    }
    initialized = 0;
    return 0;
}

LVW_EXPORT(lvw_alloc) uint32_t lvw_alloc(uint32_t bytes) {
    if (!bytes || bytes > LVW_MAX_FRAME_BYTES) return 0;
    return pointer_value(malloc(bytes));
}

LVW_EXPORT(lvw_free) void lvw_free(uint32_t pointer) {
    free((void *)(uintptr_t)pointer);
}

LVW_EXPORT(lvw_display_create) uint32_t lvw_display_create(uint32_t width, uint32_t height,
                                                            uint32_t pixel_format) {
    uint32_t size;
    if (!initialized || running || pixel_format != LVW_PIXEL_XRGB8888 ||
        frame_size(width, height, &size)) return 0;
    lvw_display_node_t *node = calloc(1, sizeof(*node));
    if (!node) return 0;
    node->pixels = calloc(1, size);
    if (!node->pixels) {
        free(node);
        return 0;
    }
    node->lvgl = lv_display_create((int32_t)width, (int32_t)height);
    if (!node->lvgl) {
        free(node->pixels);
        free(node);
        return 0;
    }
    node->width = width;
    node->height = height;
    node->byte_length = size;
    lv_display_set_user_data(node->lvgl, node);
    lv_display_set_color_format(node->lvgl, LV_COLOR_FORMAT_XRGB8888);
    lv_display_set_buffers(node->lvgl, node->pixels, NULL, size, LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_display_set_flush_cb(node->lvgl, flush_callback);
    node->next = displays;
    displays = node;
    return pointer_value(node->lvgl);
}

LVW_EXPORT(lvw_display_resize) int32_t lvw_display_resize(uint32_t display, uint32_t width,
                                                           uint32_t height) {
    if (!initialized || running) return -1;
    lvw_display_node_t *node = find_display(display);
    uint32_t size;
    if (!node || frame_size(width, height, &size)) return -2;
    if (node->width == width && node->height == height) return 0;
    uint8_t *pixels = calloc(1, size);
    if (!pixels) return -3;
    lv_display_set_resolution(node->lvgl, (int32_t)width, (int32_t)height);
    lv_display_set_buffers(node->lvgl, pixels, NULL, size, LV_DISPLAY_RENDER_MODE_DIRECT);
    free(node->pixels);
    node->pixels = pixels;
    node->width = width;
    node->height = height;
    node->byte_length = size;
    node->dirty_count = 0;
    return 0;
}

LVW_EXPORT(lvw_display_destroy) int32_t lvw_display_destroy(uint32_t display) {
    if (!initialized || running) return -1;
    lvw_display_node_t **cursor = &displays;
    while (*cursor && pointer_value((*cursor)->lvgl) != display) cursor = &(*cursor)->next;
    if (!*cursor) return -4;
    lvw_display_node_t *node = *cursor;
    lvw_indev_node_t **input_cursor = &indevs;
    while (*input_cursor) {
        if ((*input_cursor)->display == node) {
            lvw_indev_node_t *input = *input_cursor;
            *input_cursor = input->next;
            lv_indev_delete(input->lvgl);
            free(input);
        } else {
            input_cursor = &(*input_cursor)->next;
        }
    }
    *cursor = node->next;
    lv_display_delete(node->lvgl);
    free(node->pixels);
    free(node);
    return 0;
}

LVW_EXPORT(lvw_indev_create) uint32_t lvw_indev_create(uint32_t display, uint32_t type) {
    if (!initialized || running) return 0;
    lvw_display_node_t *target = find_display(display);
    if (!target || (type != LVW_INPUT_POINTER && type != LVW_INPUT_KEYPAD &&
                    type != LVW_INPUT_ENCODER)) return 0;
    lvw_indev_node_t *node = calloc(1, sizeof(*node));
    if (!node) return 0;
    node->lvgl = lv_indev_create();
    if (!node->lvgl) {
        free(node);
        return 0;
    }
    node->display = target;
    node->type = type;
    lv_indev_set_type(node->lvgl, (lv_indev_type_t)type);
    lv_indev_set_display(node->lvgl, target->lvgl);
    lv_indev_set_user_data(node->lvgl, node);
    lv_indev_set_read_cb(node->lvgl, input_callback);
    node->next = indevs;
    indevs = node;
    return pointer_value(node->lvgl);
}

LVW_EXPORT(lvw_indev_push) int32_t lvw_indev_push(uint32_t indev, uint32_t packet_ptr,
                                                   uint32_t packet_size) {
    if (!initialized || running) return -1;
    lvw_indev_node_t *node = find_indev(indev);
    if (!node || !packet_ptr || packet_size != sizeof(lvw_input_packet_t)) return -2;
    const lvw_input_packet_t *packet = (const void *)(uintptr_t)packet_ptr;
    if (packet->struct_size != sizeof(*packet) || packet->version != LVW_ABI_VERSION ||
        packet->type != node->type || packet->state > 1u ||
        packet->encoder_delta < INT16_MIN || packet->encoder_delta > INT16_MAX) return -2;
    if (node->count == LVW_INPUT_QUEUE_LEN) return -5;
    node->queue[(node->head + node->count) % LVW_INPUT_QUEUE_LEN] = *packet;
    node->count++;
    return 0;
}

LVW_EXPORT(lvw_step) int32_t lvw_step(uint32_t elapsed_ms, uint32_t out_result_ptr) {
    if (!initialized || running || callback_depth) return -1;
    if (!out_result_ptr) return -2;
    lvw_step_result_t *result = (void *)(uintptr_t)out_result_ptr;
    if (result->struct_size < sizeof(*result) || result->version != LVW_ABI_VERSION) return -2;
    running = 1;
    uint32_t before = 0;
    for (lvw_display_node_t *node = displays; node; node = node->next) {
        before += node->frame_id;
        node->dirty_count = 0;
    }
    lv_tick_inc(elapsed_ms);
    uint32_t next_ms = lv_timer_handler();
    uint32_t after = 0;
    for (lvw_display_node_t *node = displays; node; node = node->next) after += node->frame_id;
    *result = (lvw_step_result_t){sizeof(*result), LVW_ABI_VERSION, next_ms, after - before};
    running = 0;
    return 0;
}

LVW_EXPORT(lvw_frame_get) int32_t lvw_frame_get(uint32_t display, uint32_t out_frame_ptr) {
    if (!initialized || running) return -1;
    lvw_display_node_t *node = find_display(display);
    if (!node || !out_frame_ptr) return -2;
    lvw_frame_t *frame = (void *)(uintptr_t)out_frame_ptr;
    if (frame->struct_size < sizeof(*frame) || frame->version != LVW_ABI_VERSION) return -2;
    *frame = (lvw_frame_t){sizeof(*frame), LVW_ABI_VERSION, pointer_value(node->pixels),
                           node->byte_length, node->width, node->height, node->width * 4u,
                           LVW_PIXEL_XRGB8888, 0, pointer_value(node->dirty),
                           node->dirty_count, node->frame_id};
    return 0;
}

LVW_EXPORT(lvw_resource_put) int32_t lvw_resource_put(uint32_t name_ptr, uint32_t name_len,
                                                       uint32_t data_ptr, uint32_t data_len) {
    if (!initialized || running) return -1;
    if (!name_ptr || !name_len || name_len > LVW_RESOURCE_NAME_LEN || !data_ptr ||
        !data_len || data_len > LVW_MAX_FRAME_BYTES) return -2;
    const char *name = (const void *)(uintptr_t)name_ptr;
    for (uint32_t i = 0; i < name_len; i++) {
        if (!name[i] || name[i] == ':') return -2;
    }
    for (lvw_resource_t *item = resources; item; item = item->next) {
        if (strlen(item->name) == name_len && memcmp(item->name, name, name_len) == 0) return -6;
    }
    lvw_resource_t *resource = calloc(1, sizeof(*resource));
    if (!resource) return -3;
    resource->data = malloc(data_len);
    if (!resource->data) {
        free(resource);
        return -3;
    }
    memcpy(resource->name, name, name_len);
    memcpy(resource->data, (const void *)(uintptr_t)data_ptr, data_len);
    resource->length = data_len;
    resource->next = resources;
    resources = resource;
    return 0;
}

LVW_EXPORT(lvw_event_add) int32_t lvw_event_add(uint32_t object, uint32_t event_code,
                                                 uint32_t callback_id) {
    if (!initialized) return -1;
    if (!object || !callback_id) return -2;
    lv_event_dsc_t *descriptor = lv_obj_add_event_cb((lv_obj_t *)(uintptr_t)object,
                                                       event_callback, (lv_event_code_t)event_code,
                                                       (void *)(uintptr_t)callback_id);
    return descriptor ? 0 : -3;
}

LVW_EXPORT(lvw_event_remove) int32_t lvw_event_remove(uint32_t object, uint32_t callback_id) {
    if (!initialized) return -1;
    if (!object || !callback_id) return -2;
    lv_obj_remove_event_cb_with_user_data((lv_obj_t *)(uintptr_t)object, event_callback,
                                            (void *)(uintptr_t)callback_id);
    return 0;
}

LVW_EXPORT(lvw_event_clicked) uint32_t lvw_event_clicked(void) { return LV_EVENT_CLICKED; }
LVW_EXPORT(lvw_event_delete) uint32_t lvw_event_delete(void) { return LV_EVENT_DELETE; }
