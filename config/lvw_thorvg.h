#ifndef LVW_THORVG_H
#define LVW_THORVG_H

/* Some bundled sources use free without including its declaration. */
#include <stdlib.h>
#include "config.h"

/* ThorVG tests these switches with #ifdef, while LVGL defines them as 0 or 1. */
#if !THORVG_SVG_LOADER_SUPPORT
#undef THORVG_SVG_LOADER_SUPPORT
#endif
#if !THORVG_LOTTIE_LOADER_SUPPORT
#undef THORVG_LOTTIE_LOADER_SUPPORT
#endif

#if LV_USE_LOTTIE || LVW_THORVG_FILE_LOADER
#include "lvgl.h"
/* Both ThorVG file loaders use the same LVGL resource drivers. */
static inline char * lvw_thorvg_read_file(const char * path, uint32_t * size)
{
    lv_fs_file_t file;
    uint32_t length = 0;
    uint32_t read = 0;
    char * data = NULL;
    *size = 0;
    if(lv_fs_open(&file, path, LV_FS_MODE_RD) != LV_FS_RES_OK) return NULL;
    if(lv_fs_seek(&file, 0, LV_FS_SEEK_END) != LV_FS_RES_OK ||
       lv_fs_tell(&file, &length) != LV_FS_RES_OK || !length || length == UINT32_MAX ||
       lv_fs_seek(&file, 0, LV_FS_SEEK_SET) != LV_FS_RES_OK) goto done;
    data = (char *)lv_malloc(length + 1);
    if(!data) goto done;
    if(lv_fs_read(&file, data, length, &read) != LV_FS_RES_OK || read != length) {
        lv_free(data);
        data = NULL;
        goto done;
    }
    data[length] = '\0';
done:
    if(lv_fs_close(&file) != LV_FS_RES_OK) {
        lv_free(data);
        data = NULL;
    }
    if(data) *size = length;
    return data;
}
#endif

#endif
