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

#endif
