#include "lvw.h"

#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "lvgl/lvgl.h"
#if LVW_MANAGED_DECODER
#if LVW_DECODER_LEGACY
void lvw_decoder_drop_header_cache(void);
#else
#include "image/lv_image_decoder_private.h"
#include "misc/cache/instance/lv_image_header_cache.h"
#endif
#endif

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

#if LVW_MANAGED_TIMER
typedef struct lvw_timer_node {
    lv_timer_t *lvgl;
    uint32_t callback_id;
    struct lvw_timer_node *next;
} lvw_timer_node_t;
#endif

#if LVW_MANAGED_ANIMATION
typedef struct lvw_anim_node {
    lv_anim_t *lvgl;
    lv_anim_path_cb_t path;
    uint32_t callback_id;
    uint32_t exec_slot;
    uint32_t flags;
    bool creating;
    bool finishing;
    struct lvw_anim_node *next;
} lvw_anim_node_t;
#endif

#if LVW_MANAGED_OBSERVER
typedef struct lvw_observer_node {
    lv_observer_t *lvgl;
    lv_subject_t *subject;
    uint32_t callback_id;
    bool object_bound;
    struct lvw_observer_node *next;
} lvw_observer_node_t;

typedef struct lvw_observer_creation {
    lvw_observer_node_t *node;
    struct lvw_observer_creation *previous;
} lvw_observer_creation_t;
#endif

#if LVW_MANAGED_DECODER
typedef struct lvw_decoder_node {
    lv_image_decoder_t *lvgl;
    uint32_t callback_id;
    uint32_t flags;
    struct lvw_decoder_node *next;
} lvw_decoder_node_t;

typedef struct lvw_decoder_session {
    lv_image_decoder_t *decoder;
    lv_image_decoder_dsc_t *dsc;
    bool active;
    struct lvw_decoder_session *next;
} lvw_decoder_session_t;

typedef struct lvw_decoder_frame {
    lv_image_decoder_t *decoder;
    lv_image_decoder_dsc_t *dsc;
    lv_image_header_t *header;
    uint32_t phase;
    struct lvw_decoder_frame *previous;
} lvw_decoder_frame_t;

_Static_assert(sizeof(lvw_decoder_view_t) == 64, "decoder view ABI size");
#endif

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
#if LVW_MANAGED_TIMER
static lvw_timer_node_t *timers;
#endif
#if LVW_MANAGED_ANIMATION
static lvw_anim_node_t *animations;
static uint32_t anim_restricted_depth;
#endif
#if LVW_MANAGED_OBSERVER
static lvw_observer_node_t *observers;
static lvw_observer_creation_t *observer_creation;
#endif
#if LVW_MANAGED_DECODER
static lvw_decoder_node_t *decoders;
static lvw_decoder_session_t *decoder_sessions;
static lvw_decoder_frame_t *decoder_frame;
static uint32_t decoder_callback_depth;
#endif
static lvw_resource_t *resources;
static lv_fs_drv_t resource_driver;
static uint32_t initialized;
static uint32_t running;
static uint32_t callback_depth;
static lv_event_t *current_event;

__attribute__((import_module("lvw"), import_name("event")))
extern void lvw_host_event(uint32_t callback_id, uint32_t object, uint32_t code);

__attribute__((import_module("lvw"), import_name("timer")))
extern void lvw_host_timer(uint32_t callback_id, uint32_t timer);

__attribute__((import_module("lvw"), import_name("timer_release")))
extern void lvw_host_timer_release(uint32_t callback_id);

__attribute__((import_module("lvw"), import_name("anim_exec")))
extern void lvw_host_anim_exec(uint32_t callback_id, uint32_t animation, int32_t value);

__attribute__((import_module("lvw"), import_name("anim_query")))
extern int32_t lvw_host_anim_query(uint32_t callback_id, uint32_t animation, uint32_t kind);

__attribute__((import_module("lvw"), import_name("anim_notify")))
extern void lvw_host_anim_notify(uint32_t callback_id, uint32_t animation, uint32_t kind);

__attribute__((import_module("lvw"), import_name("anim_release")))
extern void lvw_host_anim_release(uint32_t callback_id);

__attribute__((import_module("lvw"), import_name("observer")))
extern void lvw_host_observer(uint32_t callback_id, uint32_t observer, uint32_t subject);

__attribute__((import_module("lvw"), import_name("observer_release")))
extern void lvw_host_observer_release(uint32_t callback_id);

__attribute__((import_module("lvw"), import_name("decoder_info")))
extern int32_t lvw_host_decoder_info(uint32_t callback_id, uint32_t decoder, uint32_t dsc,
                                     uint32_t header);

__attribute__((import_module("lvw"), import_name("decoder_open")))
extern int32_t lvw_host_decoder_open(uint32_t callback_id, uint32_t decoder, uint32_t dsc);

__attribute__((import_module("lvw"), import_name("decoder_area")))
extern int32_t lvw_host_decoder_area(uint32_t callback_id, uint32_t decoder, uint32_t dsc,
                                     uint32_t full_area, uint32_t decoded_area);

__attribute__((import_module("lvw"), import_name("decoder_close")))
extern void lvw_host_decoder_close(uint32_t callback_id, uint32_t decoder, uint32_t dsc);

__attribute__((import_module("lvw"), import_name("decoder_release")))
extern void lvw_host_decoder_release(uint32_t callback_id);

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
#if LVW_INPUT_TIMESTAMP
    data->timestamp = lv_tick_get();
#endif
    data->continue_reading = node->count != 0;
    node->current.encoder_delta = 0;
}

static void event_callback(lv_event_t *event) {
    uint32_t callback_id = pointer_value(lv_event_get_user_data(event));
    uint32_t object = pointer_value(lv_event_get_current_target_obj(event));
    lv_event_t *previous = current_event;
    current_event = event;
    callback_depth++;
    lvw_host_event(callback_id, object, (uint32_t)lv_event_get_code(event));
    callback_depth--;
    current_event = previous;
}

#if LVW_MANAGED_TIMER
static void timer_callback(lv_timer_t *timer) {
    for (lvw_timer_node_t *node = timers; node; node = node->next) {
        if (node->lvgl != timer) continue;
        uint32_t callback_id = node->callback_id;
        uint32_t handle = pointer_value(timer);
        callback_depth++;
        lvw_host_timer(callback_id, handle);
        callback_depth--;
        return;
    }
}

static void timer_release(void *data) {
    lvw_timer_node_t *node = data;
    lvw_timer_node_t **cursor = &timers;
    while (*cursor && *cursor != node) cursor = &(*cursor)->next;
    if (!*cursor) return;
    *cursor = node->next;
    uint32_t callback_id = node->callback_id;
    free(node);
    callback_depth++;
    lvw_host_timer_release(callback_id);
    callback_depth--;
}

#if !LVW_TIMER_EXTERNAL_DATA
void lvw_timer_release_native(lv_timer_t *timer) {
    for (lvw_timer_node_t *node = timers; node; node = node->next) {
        if (node->lvgl != timer) continue;
        timer_release(node);
        return;
    }
}
#endif

#endif

#if LVW_MANAGED_ANIMATION
static lvw_anim_node_t *bind_animation(const lv_anim_t *animation) {
    for (lvw_anim_node_t *node = animations; node; node = node->next) {
#if LVW_ANIMATION_EXTERNAL_DATA
        if (node != animation->ext_data.data) continue;
#else
        if (node->lvgl != animation) continue;
#endif
        if (node->lvgl && node->lvgl != animation) __builtin_trap();
        node->lvgl = (lv_anim_t *)animation;
        return node;
    }
    __builtin_trap();
}

static int32_t animation_query(const lv_anim_t *animation, uint32_t kind) {
    lvw_anim_node_t *node = bind_animation(animation);
    uint32_t callback_id = node->callback_id;
    uint32_t flags = node->flags;
    lv_anim_path_cb_t path = node->path;
    // LVGL continues accessing this animation after a query returns.
    anim_restricted_depth++;
    callback_depth++;
    int32_t value = kind == 1u && !(flags & LVW_ANIM_PATH)
                    ? path(animation)
                    : lvw_host_anim_query(callback_id, pointer_value(animation), kind);
    callback_depth--;
    anim_restricted_depth--;
    return value;
}

static int32_t animation_path(const lv_anim_t *animation) {
    // Older native early-apply paths use the start value without querying a path.
    return animation_query(animation, 1u);
}

static int32_t animation_get_value(lv_anim_t *animation) {
    return animation_query(animation, 2u);
}

static void animation_notify(lv_anim_t *animation, uint32_t kind, uint32_t flag) {
    lvw_anim_node_t *node = bind_animation(animation);
    if (kind != 1u) node->finishing = true;
    if (!(node->flags & flag)) return;
    uint32_t callback_id = node->callback_id;
    // Terminal callbacks can run inside native delete_all's cached-next traversal.
    anim_restricted_depth++;
    callback_depth++;
    lvw_host_anim_notify(callback_id, pointer_value(animation), kind);
    callback_depth--;
    anim_restricted_depth--;
}

static void animation_start(lv_anim_t *animation) {
    animation_notify(animation, 1u, LVW_ANIM_START);
}

static void animation_completed(lv_anim_t *animation) {
    animation_notify(animation, 2u, LVW_ANIM_COMPLETED);
}

static void animation_deleted(lv_anim_t *animation) {
    animation_notify(animation, 3u, LVW_ANIM_DELETED);
}

static void animation_release(void *data) {
    lvw_anim_node_t **cursor = &animations;
    while (*cursor && *cursor != data) cursor = &(*cursor)->next;
    if (!*cursor) return;
    lvw_anim_node_t *node = *cursor;
    *cursor = node->next;
    uint32_t callback_id = node->callback_id;
    free(node);
    anim_restricted_depth++;
    callback_depth++;
    lvw_host_anim_release(callback_id);
    callback_depth--;
    anim_restricted_depth--;
}

#if !LVW_ANIMATION_EXTERNAL_DATA
void lvw_anim_bind_native(lv_anim_t *animation) {
    for (lvw_anim_node_t *node = animations; node; node = node->next) {
        if (node->exec_slot != (uint32_t)(uintptr_t)animation->exec_cb) continue;
        if (!node->creating || node->lvgl) __builtin_trap();
        node->lvgl = animation;
        return;
    }
}

void lvw_anim_release_native(lv_anim_t *animation) {
    for (lvw_anim_node_t *node = animations; node; node = node->next) {
        if (node->lvgl != animation) continue;
        animation_release(node);
        return;
    }
}

// Legacy clear_all has no native deleted notification. Notify managed records only.
void lvw_anim_clear_native(lv_anim_t *animation) {
    for (lvw_anim_node_t *node = animations; node; node = node->next) {
        if (node->lvgl != animation) continue;
        animation_deleted(animation);
        animation_release(node);
        return;
    }
}
#endif

#endif

#if LVW_MANAGED_OBSERVER
static void observer_callback(lv_observer_t *observer, lv_subject_t *subject) {
    lvw_observer_node_t *node = observers;
    while (node && node->lvgl != observer) node = node->next;
    if (!node) {
        node = observer_creation ? observer_creation->node : NULL;
        if (!node || node->lvgl || node->subject != subject) __builtin_trap();
        node->lvgl = observer;
    }
    if (node->subject != subject) __builtin_trap();
    uint32_t callback_id = node->callback_id;
    uint32_t handle = pointer_value(observer);
    uint32_t subject_handle = pointer_value(subject);
    callback_depth++;
    lvw_host_observer(callback_id, handle, subject_handle);
    callback_depth--;
}

// Called by the adapted native deletion path after unlinking the observer.
void lvw_observer_release_native(lv_observer_t *observer) {
    lvw_observer_node_t **cursor = &observers;
    while (*cursor && (*cursor)->lvgl != observer) cursor = &(*cursor)->next;
    if (!*cursor) return;
    lvw_observer_node_t *node = *cursor;
    *cursor = node->next;
    for (lvw_observer_creation_t *frame = observer_creation; frame; frame = frame->previous) {
        if (frame->node == node) frame->node = NULL;
    }
    uint32_t callback_id = node->callback_id;
    free(node);
    callback_depth++;
    lvw_host_observer_release(callback_id);
    callback_depth--;
}

#endif

#if LVW_MANAGED_DECODER
static lvw_decoder_node_t *find_decoder(lv_image_decoder_t *decoder) {
    for (lvw_decoder_node_t *node = decoders; node; node = node->next) {
        if (node->lvgl == decoder) return node;
    }
    __builtin_trap();
}

static lvw_decoder_session_t *find_decoder_session(lv_image_decoder_dsc_t *dsc) {
    for (lvw_decoder_session_t *session = decoder_sessions; session; session = session->next) {
        if (session->dsc == dsc) return session;
    }
    return NULL;
}

static void remove_decoder_session(lvw_decoder_session_t *session) {
    lvw_decoder_session_t **cursor = &decoder_sessions;
    while (*cursor && *cursor != session) cursor = &(*cursor)->next;
    if (!*cursor) __builtin_trap();
    *cursor = session->next;
    free(session);
}

static void decoder_enter(lvw_decoder_frame_t *frame) {
    for (lvw_decoder_frame_t *active = decoder_frame; active; active = active->previous) {
        if (active->dsc == frame->dsc) __builtin_trap();
    }
    frame->previous = decoder_frame;
    decoder_frame = frame;
    decoder_callback_depth++;
    callback_depth++;
}

static void decoder_leave(lvw_decoder_frame_t *frame) {
    if (decoder_frame != frame) __builtin_trap();
    callback_depth--;
    decoder_callback_depth--;
    decoder_frame = frame->previous;
}

static lv_result_t decoder_result(int32_t result) {
    if (result != LV_RESULT_OK && result != LV_RESULT_INVALID) __builtin_trap();
    return (lv_result_t)result;
}

static lv_result_t decoder_info_session(lv_image_decoder_t *decoder, lv_image_decoder_dsc_t *dsc,
                                 lv_image_header_t *header) {
    lvw_decoder_node_t *node = find_decoder(decoder);
    if (find_decoder_session(dsc)) __builtin_trap();
    lvw_decoder_frame_t frame = {decoder, dsc, header, LVW_DECODER_PHASE_INFO, NULL};
    decoder_enter(&frame);
    int32_t result = lvw_host_decoder_info(node->callback_id, pointer_value(decoder),
                                          pointer_value(dsc), pointer_value(header));
    decoder_leave(&frame);
    return decoder_result(result);
}

#if LVW_DECODER_LEGACY
static lv_result_t decoder_info(lv_image_decoder_t *decoder, const void *src, lv_image_header_t *header) {
    lv_image_decoder_dsc_t dsc = {.decoder = decoder, .src = src, .src_type = lv_image_src_get_type(src)};
    return decoder_info_session(decoder, &dsc, header);
}
#else
#define decoder_info decoder_info_session
#endif

static lv_result_t decoder_open(lv_image_decoder_t *decoder, lv_image_decoder_dsc_t *dsc) {
    lvw_decoder_node_t *node = find_decoder(decoder);
    if (find_decoder_session(dsc)) __builtin_trap();
    lvw_decoder_session_t *session = malloc(sizeof(*session));
    if (!session) return LV_RESULT_INVALID;
    *session = (lvw_decoder_session_t){decoder, dsc, false, decoder_sessions};
    decoder_sessions = session;
    lvw_decoder_frame_t frame = {decoder, dsc, &dsc->header, LVW_DECODER_PHASE_OPEN, NULL};
    decoder_enter(&frame);
    int32_t result = lvw_host_decoder_open(node->callback_id, pointer_value(decoder), pointer_value(dsc));
    decoder_leave(&frame);
    lv_result_t status = decoder_result(result);
    if (status == LV_RESULT_OK) session->active = true;
    else remove_decoder_session(session);
    return status;
}

static lv_result_t decoder_area(lv_image_decoder_t *decoder, lv_image_decoder_dsc_t *dsc,
                                 const lv_area_t *full_area, lv_area_t *decoded_area) {
    lvw_decoder_node_t *node = find_decoder(decoder);
    lvw_decoder_session_t *session = find_decoder_session(dsc);
    if (!session || session->decoder != decoder || !session->active) __builtin_trap();
    lvw_decoder_frame_t frame = {decoder, dsc, &dsc->header, LVW_DECODER_PHASE_AREA, NULL};
    decoder_enter(&frame);
    int32_t result = lvw_host_decoder_area(node->callback_id, pointer_value(decoder), pointer_value(dsc),
                                          pointer_value(full_area), pointer_value(decoded_area));
    decoder_leave(&frame);
    return decoder_result(result);
}

static void decoder_close(lv_image_decoder_t *decoder, lv_image_decoder_dsc_t *dsc) {
    lvw_decoder_node_t *node = find_decoder(decoder);
    lvw_decoder_session_t *session = find_decoder_session(dsc);
    if (!session) return;
    if (session->decoder != decoder || !session->active) __builtin_trap();
    session->active = false;
    lvw_decoder_frame_t frame = {decoder, dsc, &dsc->header, LVW_DECODER_PHASE_CLOSE, NULL};
    decoder_enter(&frame);
    if (node->flags & LVW_DECODER_CLOSE) {
        lvw_host_decoder_close(node->callback_id, pointer_value(decoder), pointer_value(dsc));
    }
    decoder_leave(&frame);
    // Native close still reads dsc->decoder after this callback returns.
    remove_decoder_session(session);
}

// Native delete and deinit call this after unlinking the decoder.
void lvw_decoder_release_native(lv_image_decoder_t *decoder) {
    lvw_decoder_node_t **cursor = &decoders;
    while (*cursor && (*cursor)->lvgl != decoder) cursor = &(*cursor)->next;
    if (!*cursor) return;
    lvw_decoder_node_t *node = *cursor;
    *cursor = node->next;
    lvw_decoder_session_t **session = &decoder_sessions;
    while (*session) {
        if ((*session)->decoder != decoder) {
            session = &(*session)->next;
            continue;
        }
        lvw_decoder_session_t *removed = *session;
        *session = removed->next;
        free(removed);
    }
    uint32_t callback_id = node->callback_id;
    free(node);
    decoder_callback_depth++;
    callback_depth++;
    lvw_host_decoder_release(callback_id);
    callback_depth--;
    decoder_callback_depth--;
}

#endif

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
#if LVW_MANAGED_TIMER
    while (timers) lv_timer_delete(timers->lvgl);
#endif
#if LVW_MANAGED_OBSERVER
    while (observers) LVW_OBSERVER_DELETE(observers->lvgl);
#endif
#if LVW_MANAGED_DECODER
    while (decoders) lv_image_decoder_delete(decoders->lvgl);
#endif
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
    lv_obj_t *target = (lv_obj_t *)(uintptr_t)object;
    uint32_t before = lv_obj_get_event_count(target);
    // Registration does not dispatch events; older LVGL returns void here.
    lv_obj_add_event_cb(target, event_callback, (lv_event_code_t)event_code,
                       (void *)(uintptr_t)callback_id);
    return lv_obj_get_event_count(target) == before + 1u ? 0 : -3;
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
LVW_EXPORT(lvw_event_current) uint32_t lvw_event_current(void) { return pointer_value(current_event); }

#if LVW_MANAGED_TIMER
LVW_EXPORT(lvw_timer_create) uint32_t lvw_timer_create(uint32_t period_ms, uint32_t user_data,
                                                       uint32_t callback_id) {
    if (!initialized || !callback_id) return 0;
    for (lvw_timer_node_t *node = timers; node; node = node->next) {
        if (node->callback_id == callback_id) return 0;
    }
    lvw_timer_node_t *node = malloc(sizeof(*node));
    if (!node) return 0;
    lv_timer_t *timer = lv_timer_create(timer_callback, period_ms, (void *)(uintptr_t)user_data);
    if (!timer) {
        free(node);
        return 0;
    }
    *node = (lvw_timer_node_t){timer, callback_id, timers};
    timers = node;
#if LVW_TIMER_EXTERNAL_DATA
    lv_timer_set_external_data(timer, node, timer_release);
#endif
    return pointer_value(timer);
}

LVW_EXPORT(lvw_timer_delete) int32_t lvw_timer_delete(uint32_t timer, uint32_t callback_id) {
    if (!initialized) return -1;
    if (!timer || !callback_id) return -2;
    for (lvw_timer_node_t *node = timers; node; node = node->next) {
        if (pointer_value(node->lvgl) == timer && node->callback_id == callback_id) {
            lv_timer_delete(node->lvgl);
            return 0;
        }
    }
    return 0;
}

#endif

#if LVW_MANAGED_ANIMATION
LVW_EXPORT(lvw_anim_start) uint32_t lvw_anim_start(uint32_t descriptor, uint32_t callback_id,
                                                   uint32_t exec_slot, uint32_t flags) {
    const uint32_t known_flags = LVW_ANIM_PATH | LVW_ANIM_GET_VALUE | LVW_ANIM_START |
                                 LVW_ANIM_COMPLETED | LVW_ANIM_DELETED;
    if (!initialized || !descriptor || !callback_id || !exec_slot || (flags & ~known_flags)) return 0;
    for (lvw_anim_node_t *node = animations; node; node = node->next) {
        if (node->callback_id == callback_id || node->exec_slot == exec_slot) return 0;
    }
    const lv_anim_t *source = (const lv_anim_t *)(uintptr_t)descriptor;
    if (!source->path_cb || source->exec_cb || source->custom_exec_cb || source->get_value_cb ||
        source->start_cb || source->completed_cb || source->deleted_cb) return 0;
#if LVW_ANIMATION_EXTERNAL_DATA
    if (source->ext_data.data || source->ext_data.free_cb) return 0;
#endif
    lvw_anim_node_t *node = calloc(1, sizeof(*node));
    if (!node) return 0;
    node->path = source->path_cb;
    node->callback_id = callback_id;
    node->exec_slot = exec_slot;
    node->flags = flags;
    node->creating = true;
    node->next = animations;
    animations = node;

    lv_anim_t copy = *source;
    if (source->var == source) copy.var = &copy;
    copy.exec_cb = (lv_anim_exec_xcb_t)(uintptr_t)exec_slot;
    copy.path_cb = animation_path;
    copy.get_value_cb = flags & LVW_ANIM_GET_VALUE ? animation_get_value : NULL;
    copy.start_cb = animation_start;
    copy.completed_cb = animation_completed;
    copy.deleted_cb = animation_deleted;
#if LVW_ANIMATION_EXTERNAL_DATA
    lv_anim_set_external_data(&copy, node, animation_release);
#endif
    lv_anim_t *created = lv_anim_start(&copy);
    if (!created) {
        animation_release(node);
        return 0;
    }
    // A callback can release a registration; never revive it from the returned address.
    for (lvw_anim_node_t *active = animations; active; active = active->next) {
        if (active->callback_id != callback_id || active->exec_slot != exec_slot) continue;
        if (active->finishing) return 0;
        if (active->lvgl && active->lvgl != created) __builtin_trap();
        active->lvgl = created;
        active->creating = false;
        return pointer_value(created);
    }
    return 0;
}

LVW_EXPORT(lvw_anim_delete) int32_t lvw_anim_delete(uint32_t animation, uint32_t callback_id) {
    if (!initialized) return -1;
    if (!animation || !callback_id) return -2;
    for (lvw_anim_node_t *node = animations; node; node = node->next) {
        if (pointer_value(node->lvgl) != animation || node->callback_id != callback_id) continue;
        if (node->finishing) return 0;
        if (anim_restricted_depth) return -3;
        lv_anim_delete(node->lvgl->var, (lv_anim_exec_xcb_t)(uintptr_t)node->exec_slot);
        return 0;
    }
    return 0;
}

LVW_EXPORT(lvw_anim_exec) void lvw_anim_exec(uint32_t exec_slot, uint32_t var, int32_t value) {
    if (!initialized) __builtin_trap();
    for (lvw_anim_node_t *node = animations; node; node = node->next) {
        if (node->exec_slot != exec_slot) continue;
        if (!node->lvgl || node->finishing || pointer_value(node->lvgl->var) != var) __builtin_trap();
        uint32_t callback_id = node->callback_id;
        uint32_t animation = pointer_value(node->lvgl);
        bool restricted = node->creating;
        if (restricted) anim_restricted_depth++;
        callback_depth++;
        lvw_host_anim_exec(callback_id, animation, value);
        callback_depth--;
        if (restricted) anim_restricted_depth--;
        return;
    }
    __builtin_trap();
}

#endif

#if LVW_MANAGED_OBSERVER
LVW_EXPORT(lvw_observer_create) uint32_t lvw_observer_create(uint32_t subject, uint32_t target,
                                                            uint32_t user_data, uint32_t callback_id,
                                                            uint32_t mode) {
    if (!initialized || !subject || !callback_id || mode > LVW_OBSERVER_MODE_OBJECT) return 0;
    for (lvw_observer_node_t *node = observers; node; node = node->next) {
        if (node->callback_id == callback_id) return 0;
    }
    lvw_observer_node_t *node = calloc(1, sizeof(*node));
    if (!node) return 0;
    node->subject = (lv_subject_t *)(uintptr_t)subject;
    node->callback_id = callback_id;
    node->object_bound = mode == LVW_OBSERVER_MODE_OBJECT && target != 0;
    node->next = observers;
    observers = node;

    lvw_observer_creation_t frame = {node, observer_creation};
    observer_creation = &frame;
    lv_observer_t *created = mode == LVW_OBSERVER_MODE_OBJECT
        ? lv_subject_add_observer_obj(node->subject, observer_callback,
                                      (lv_obj_t *)(uintptr_t)target, (void *)(uintptr_t)user_data)
        : lv_subject_add_observer_with_target(node->subject, observer_callback,
                                              (void *)(uintptr_t)target, (void *)(uintptr_t)user_data);
    observer_creation = frame.previous;
    if (!created) {
        // A failed native allocation has not invoked the initial callback.
        if (!frame.node || frame.node->lvgl || observers != frame.node) __builtin_trap();
        observers = frame.node->next;
        free(frame.node);
        return 0;
    }
    if (frame.node && frame.node->lvgl != created) __builtin_trap();
    // Initial notification may have released this registration; never revive it.
    return pointer_value(created);
}

LVW_EXPORT(lvw_observer_delete) int32_t lvw_observer_delete(uint32_t observer, uint32_t callback_id) {
    if (!initialized) return -1;
    if (!observer || !callback_id) return -2;
    for (lvw_observer_node_t *node = observers; node; node = node->next) {
        if (pointer_value(node->lvgl) != observer || node->callback_id != callback_id) continue;
        if (node->object_bound) return -3;
        LVW_OBSERVER_DELETE(node->lvgl);
        return 0;
    }
    return 0;
}

#endif

#if LVW_MANAGED_DECODER
LVW_EXPORT(lvw_decoder_create) uint32_t lvw_decoder_create(uint32_t user_data, uint32_t callback_id,
                                                          uint32_t flags) {
    if (!initialized || !callback_id || (flags & ~(LVW_DECODER_GET_AREA | LVW_DECODER_CLOSE))) return 0;
    for (lvw_decoder_node_t *node = decoders; node; node = node->next) {
        if (node->callback_id == callback_id) return 0;
    }
    lvw_decoder_node_t *node = malloc(sizeof(*node));
    if (!node) return 0;
    lv_image_decoder_t *decoder = lv_image_decoder_create();
    if (!decoder) {
        free(node);
        return 0;
    }
    *node = (lvw_decoder_node_t){decoder, callback_id, flags, decoders};
    decoders = node;
    decoder->user_data = (void *)(uintptr_t)user_data;
#if !LVW_DECODER_LEGACY
    decoder->name = "host";
#endif
    lv_image_decoder_set_info_cb(decoder, decoder_info);
    lv_image_decoder_set_open_cb(decoder, decoder_open);
    lv_image_decoder_set_get_area_cb(decoder, flags & LVW_DECODER_GET_AREA ? decoder_area : NULL);
    lv_image_decoder_set_close_cb(decoder, decoder_close);
    return pointer_value(decoder);
}

LVW_EXPORT(lvw_decoder_delete) int32_t lvw_decoder_delete(uint32_t decoder, uint32_t callback_id) {
    if (!initialized) return -1;
    if (!decoder || !callback_id) return -2;
    for (lvw_decoder_node_t *node = decoders; node; node = node->next) {
        if (pointer_value(node->lvgl) != decoder || node->callback_id != callback_id) continue;
        if (decoder_callback_depth) return -3;
        for (lvw_decoder_session_t *session = decoder_sessions; session; session = session->next) {
            if (session->decoder == node->lvgl) return -3;
        }
#if LVW_DECODER_LEGACY
        lvw_decoder_drop_header_cache();
#else
        lv_image_header_cache_drop(NULL);
#endif
        lv_image_decoder_delete(node->lvgl);
        return 0;
    }
    return 0;
}

LVW_EXPORT(lvw_decoder_read) int32_t lvw_decoder_read(uint32_t decoder, uint32_t dsc,
                                                     uint32_t output, uint32_t size) {
    if (!initialized) return -1;
    if (!decoder || !dsc || !output || size < sizeof(lvw_decoder_view_t)) return -2;
    lvw_decoder_frame_t *frame = decoder_frame;
    if (!frame || pointer_value(frame->decoder) != decoder || pointer_value(frame->dsc) != dsc) return -3;
    lv_image_decoder_dsc_t *source = frame->dsc;
    uint32_t args = (source->args.stride_align ? 1u : 0u) | (source->args.premultiply ? 2u : 0u)
                    | (source->args.no_cache ? 4u : 0u) | (source->args.use_indexed ? 8u : 0u);
    uint32_t file = 0;
#if !LVW_DECODER_LEGACY
    args |= source->args.flush_cache ? 16u : 0u;
    if (frame->phase == LVW_DECODER_PHASE_INFO && source->src_type == LV_IMAGE_SRC_FILE) {
        file = pointer_value(&source->file);
    }
#endif
    lvw_decoder_view_t view = {
        sizeof(view), 1u, pointer_value(source->src), (uint32_t)source->src_type,
        pointer_value(frame->header), pointer_value(source->decoded), pointer_value(source->palette),
        source->palette_size, pointer_value(source->user_data), pointer_value(frame->decoder->user_data),
        file,
        args, source->time_to_open, pointer_value(source->error_msg), frame->phase, 0u,
    };
    memcpy((void *)(uintptr_t)output, &view, sizeof(view));
    return 0;
}

LVW_EXPORT(lvw_decoder_write) int32_t lvw_decoder_write(uint32_t decoder, uint32_t dsc,
                                                       uint32_t decoded, uint32_t palette,
                                                       uint32_t palette_size, uint32_t user_data,
                                                       uint32_t time_to_open, uint32_t error_msg) {
    if (!initialized) return -1;
    if (!decoder || !dsc) return -2;
    lvw_decoder_frame_t *frame = decoder_frame;
    if (!frame || pointer_value(frame->decoder) != decoder || pointer_value(frame->dsc) != dsc
        || frame->phase == LVW_DECODER_PHASE_INFO) return -3;
    frame->dsc->decoded = (const lv_draw_buf_t *)(uintptr_t)decoded;
    frame->dsc->palette = (const lv_color32_t *)(uintptr_t)palette;
    frame->dsc->palette_size = palette_size;
    frame->dsc->user_data = (void *)(uintptr_t)user_data;
    frame->dsc->time_to_open = time_to_open;
    frame->dsc->error_msg = (const char *)(uintptr_t)error_msg;
    return 0;
}
#endif
