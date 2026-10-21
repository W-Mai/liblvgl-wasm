# Adapt the pinned Lottie widget and ThorVG resource readers in the build directory.
function(lvw_lottie_load target relative hash)
    set(source "${lvgl_SOURCE_DIR}/${relative}")
    get_filename_component(name "${source}" NAME)
    set(adapted "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/${name}")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${source}")
    file(SHA256 "${source}" actual)
    if(NOT actual STREQUAL hash)
        file(REMOVE "${adapted}")
        message(FATAL_ERROR "Unsupported Lottie source: ${source}")
    endif()
    file(READ "${source}" code)
    set(LVW_LOTTIE_TARGET "${target}" PARENT_SCOPE)
    set(LVW_LOTTIE_SOURCE "${source}" PARENT_SCOPE)
    set(LVW_LOTTIE_ADAPTED "${adapted}" PARENT_SCOPE)
    set(LVW_LOTTIE_CODE "${code}" PARENT_SCOPE)
endfunction()

function(lvw_lottie_anchor anchor output)
    string(FIND "${LVW_LOTTIE_CODE}" "${anchor}" first)
    string(FIND "${LVW_LOTTIE_CODE}" "${anchor}" last REVERSE)
    if(first LESS 0 OR NOT first EQUAL last)
        file(REMOVE "${LVW_LOTTIE_ADAPTED}")
        message(FATAL_ERROR "Lottie adaptation requires a unique source anchor")
    endif()
    set(${output} ${first} PARENT_SCOPE)
endfunction()

function(lvw_lottie_replace before after)
    lvw_lottie_anchor("${before}" first)
    string(REPLACE "${before}" "${after}" code "${LVW_LOTTIE_CODE}")
    set(LVW_LOTTIE_CODE "${code}" PARENT_SCOPE)
endfunction()

function(lvw_lottie_region begin end replacement)
    lvw_lottie_anchor("${begin}" first)
    lvw_lottie_anchor("${end}" last)
    if(NOT first LESS last)
        message(FATAL_ERROR "Invalid Lottie source region")
    endif()
    string(SUBSTRING "${LVW_LOTTIE_CODE}" 0 ${first} prefix)
    string(SUBSTRING "${LVW_LOTTIE_CODE}" ${last} -1 suffix)
    set(LVW_LOTTIE_CODE "${prefix}${replacement}${suffix}" PARENT_SCOPE)
endfunction()

function(lvw_lottie_save)
    file(CONFIGURE OUTPUT "${LVW_LOTTIE_ADAPTED}" CONTENT "${LVW_LOTTIE_CODE}" @ONLY)
    get_target_property(sources ${LVW_LOTTIE_TARGET} SOURCES)
    list(FIND sources "${LVW_LOTTIE_SOURCE}" index)
    list(LENGTH sources before)
    list(REMOVE_ITEM sources "${LVW_LOTTIE_SOURCE}")
    list(LENGTH sources after)
    math(EXPR removed "${before} - ${after}")
    if(NOT removed EQUAL 1)
        message(FATAL_ERROR "Expected one Lottie compilation unit: ${LVW_LOTTIE_SOURCE}")
    endif()
    list(INSERT sources ${index} "${LVW_LOTTIE_ADAPTED}")
    set_property(TARGET ${LVW_LOTTIE_TARGET} PROPERTY SOURCES "${sources}")
    get_filename_component(directory "${LVW_LOTTIE_SOURCE}" DIRECTORY)
    set_source_files_properties("${LVW_LOTTIE_ADAPTED}" TARGET_DIRECTORY ${LVW_LOTTIE_TARGET}
        PROPERTIES INCLUDE_DIRECTORIES "${directory}")
endfunction()

lvw_lottie_load(lvgl_thorvg src/libs/thorvg/tvgLottieLoader.cpp
    8d70f0f437984a44d904b394af828c58188f4fc37c7c25e2a8a08a080f2345da)
lvw_lottie_replace([=[#include "tvgStr.h"]=] [=[#include "tvgStr.h"
#include "rapidjson/stringbuffer.h"
#include "rapidjson/writer.h"

/* The shape SAX dispatcher needs ty before the shape's other properties. */
static bool lottie_write(const rapidjson::Value& value, rapidjson::Writer<rapidjson::StringBuffer>& writer)
{
    if (value.IsObject()) {
        if (!writer.StartObject()) return false;
        auto type = value.FindMember("ty");
        if (type != value.MemberEnd()) {
            if (!writer.Key("ty") || !lottie_write(type->value, writer)) return false;
        }
        for (auto member = value.MemberBegin(); member != value.MemberEnd(); ++member) {
            if (member == type) continue;
            if (!writer.Key(member->name.GetString(), member->name.GetStringLength()) ||
                !lottie_write(member->value, writer)) return false;
        }
        return writer.EndObject();
    }
    if (value.IsArray()) {
        if (!writer.StartArray()) return false;
        for (auto& item : value.GetArray()) if (!lottie_write(item, writer)) return false;
        return writer.EndArray();
    }
    return value.Accept(writer);
}
]=])
lvw_lottie_replace([=[bool LottieLoader::header()
{]=] [=[bool LottieLoader::header()
{
    rapidjson::Document document;
    document.Parse(content, size);
    if (document.HasParseError() || !document.IsObject()) return false;
    rapidjson::StringBuffer buffer;
    rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
    if (!lottie_write(document, writer) || buffer.GetSize() >= UINT32_MAX) return false;
    auto normalized = (char*)lv_malloc(buffer.GetSize() + 1);
    if (!normalized) return false;
    memcpy(normalized, buffer.GetString(), buffer.GetSize() + 1);
    if (copy) lv_free((char*)content);
    content = normalized;
    size = buffer.GetSize();
    copy = true;
]=])
lvw_lottie_region([=[bool LottieLoader::open(const string& path)
{]=] [=[bool LottieLoader::resize(]=] [=[bool LottieLoader::open(const string& path)
{
    auto data = lvw_thorvg_read_file(path.c_str(), &size);
    if (!data) return false;
    this->dirName = strDirname(path.c_str());
    this->content = data;
    this->copy = true;
    return header();
}


]=])
lvw_lottie_save()

lvw_lottie_load(lvgl_thorvg src/libs/thorvg/tvgSvgLoader.cpp
    1197133ca910566676936aeb3b122498aeb7f5fa09be8af41f60a390984e38e7)
lvw_lottie_replace("#include <fstream>\n" "")
lvw_lottie_region([=[bool SvgLoader::open(const string& path)
{]=] [=[bool SvgLoader::resize(]=] [=[bool SvgLoader::open(const string& path)
{
    clear();
    content = lvw_thorvg_read_file(path.c_str(), &size);
    if (!content) return false;
    copy = true;
    svgPath = path;
    return header();
}


]=])
lvw_lottie_save()

lvw_lottie_load(lvgl_thorvg src/libs/thorvg/tvgLoader.cpp
    d8178cc9c6f913fc5f28be2e79e2bed7136362449ed76108ddf4e432ca5cb319)
# Mutable scene loaders cannot be shared, regardless of an extension or MIME hint.
string(REGEX MATCHALL [=[if \(loader->open\((path|data, size, copy)\)\) \{
 +if \(allowCache\)]=] LVW_SCENE_CACHES "${LVW_LOTTIE_CODE}")
list(LENGTH LVW_SCENE_CACHES LVW_SCENE_CACHE_COUNT)
if(NOT LVW_SCENE_CACHE_COUNT EQUAL 4)
    message(FATAL_ERROR "Expected four ThorVG scene cache insertion paths")
endif()
foreach(anchor IN LISTS LVW_SCENE_CACHES)
    string(REPLACE "if (allowCache)" "if (allowCache && loader->type != FileType::Lottie && loader->type != FileType::Svg)"
        replacement "${anchor}")
    string(REPLACE "${anchor}" "${replacement}" LVW_LOTTIE_CODE "${LVW_LOTTIE_CODE}")
endforeach()
lvw_lottie_save()

lvw_lottie_load(lvgl src/widgets/lottie/lv_lottie.c
    4e0bf9527ca0ee9364408d9a7afd12dcde0e21295affe833a6496e93039dcb46)
lvw_lottie_replace([=[static void lottie_update(lv_lottie_t * lottie, int32_t v);]=]
    [=[static void lottie_update(lv_lottie_t * lottie, int32_t v);
static lv_anim_t * lottie_start_anim(lv_obj_t * obj);]=])
lvw_lottie_replace([=[    LV_CHECK_ARG(buf != NULL, return);]=]
    [=[    LV_CHECK_ARG(buf != NULL && w > 0 && w <= UINT16_MAX / 4 && h > 0 && h <= UINT16_MAX, return);]=])
lvw_lottie_replace([=[    tvg_swcanvas_set_target(lottie->tvg_canvas, buf, stride / 4, w, h, TVG_COLORSPACE_ARGB8888);
    tvg_canvas_push(lottie->tvg_canvas, lottie->tvg_paint);
    lv_canvas_set_buffer(obj, buf, w, h, LV_COLOR_FORMAT_ARGB8888_PREMULTIPLIED);
    tvg_picture_set_size(lottie->tvg_paint, w, h);]=]
    [=[    tvg_canvas_sync(lottie->tvg_canvas);
    if(tvg_swcanvas_set_target(lottie->tvg_canvas, buf, stride / 4, w, h,
                               TVG_COLORSPACE_ARGB8888) != TVG_RESULT_SUCCESS) return;
    tvg_canvas_clear(lottie->tvg_canvas, true);
    lv_canvas_set_buffer(obj, buf, w, h, LV_COLOR_FORMAT_ARGB8888_PREMULTIPLIED);
    tvg_picture_set_size(lottie->tvg_paint, w, h);
    tvg_canvas_push(lottie->tvg_canvas, lottie->tvg_paint);]=])
lvw_lottie_replace([=[    tvg_swcanvas_set_target(lottie->tvg_canvas, (void *)draw_buf->data, draw_buf->header.stride / 4,
                            draw_buf->header.w, draw_buf->header.h, TVG_COLORSPACE_ARGB8888);
    tvg_canvas_push(lottie->tvg_canvas, lottie->tvg_paint);
    lv_canvas_set_draw_buf(obj, draw_buf);
    tvg_picture_set_size(lottie->tvg_paint, draw_buf->header.w, draw_buf->header.h);]=]
    [=[    /* ThorVG uses a stride measured in 32-bit pixels. */
    if(!draw_buf->data || !draw_buf->header.w || !draw_buf->header.h ||
       draw_buf->header.stride < (uint32_t)draw_buf->header.w * 4 || draw_buf->header.stride % 4 ||
       draw_buf->data_size < (uint32_t)draw_buf->header.stride * draw_buf->header.h) return;
    tvg_canvas_sync(lottie->tvg_canvas);
    if(tvg_swcanvas_set_target(lottie->tvg_canvas, (void *)draw_buf->data, draw_buf->header.stride / 4,
                               draw_buf->header.w, draw_buf->header.h,
                               TVG_COLORSPACE_ARGB8888) != TVG_RESULT_SUCCESS) return;
    tvg_canvas_clear(lottie->tvg_canvas, true);
    draw_buf->header.cf = LV_COLOR_FORMAT_ARGB8888_PREMULTIPLIED;
    lv_canvas_set_draw_buf(obj, draw_buf);
    tvg_picture_set_size(lottie->tvg_paint, draw_buf->header.w, draw_buf->header.h);
    tvg_canvas_push(lottie->tvg_canvas, lottie->tvg_paint);]=])
lvw_lottie_region([=[void lv_lottie_set_src_data(]=] [=[lv_anim_t * lv_lottie_get_anim(]=]
    [=[static void lottie_set_src(lv_obj_t * obj, const void * src, size_t size, bool file)
{
    lv_lottie_t * lottie = (lv_lottie_t *)obj;
    Tvg_Animation * next = tvg_animation_new();
    if(!next) return;
    Tvg_Paint * paint = tvg_animation_get_picture(next);
    Tvg_Result result = file ? tvg_picture_load(paint, src) :
                        tvg_picture_load_data(paint, src, size, "lottie", true);
    float frames = 0;
    float duration = 0;
    tvg_animation_get_total_frame(next, &frames);
    tvg_animation_get_duration(next, &duration);
    if(result != TVG_RESULT_SUCCESS ||
       !(frames >= 1 && frames < 2147483648.0f && duration > 0 && duration <= 2147483.0f)) {
        tvg_animation_del(next);
        return;
    }

    /* Parse before replacing the current scene; failure leaves playback intact. */
    lv_draw_buf_t * draw_buf = lv_canvas_get_draw_buf(obj);
    if(draw_buf) tvg_picture_set_size(paint, draw_buf->header.w, draw_buf->header.h);
    tvg_canvas_sync(lottie->tvg_canvas);
    tvg_canvas_clear(lottie->tvg_canvas, true);
    tvg_animation_del(lottie->tvg_anim);
    lottie->tvg_anim = next;
    lottie->tvg_paint = paint;
    if(draw_buf) tvg_canvas_push(lottie->tvg_canvas, paint);

    lv_anim_t * anim = lv_lottie_get_anim(obj);
    if(!anim) anim = lottie_start_anim(obj);
    if(anim) {
        lv_anim_set_duration(anim, LV_MAX(1, (uint32_t)(duration * 1000.0f + 0.5f)));
        lv_anim_set_values(anim, 0, (int32_t)frames);
        anim->act_time = 0;
        anim->current_value = 0;
        anim->last_timer_run = lv_tick_get();
        anim->start_cb_called = false;
        anim->reverse_play_in_progress = false;
        lv_anim_resume(anim);
    }
    lottie->last_rendered_time = 0;
    lottie_update(lottie, 0);
}

void lv_lottie_set_src_data(lv_obj_t * obj, const void * src, size_t src_size)
{
    LV_CHECK_OBJ(obj, MY_CLASS, return);
    LV_CHECK_ARG(src != NULL, return);
    lottie_set_src(obj, src, src_size, false);
}

void lv_lottie_set_src_file(lv_obj_t * obj, const char * src)
{
    LV_CHECK_OBJ(obj, MY_CLASS, return);
    LV_CHECK_ARG(src != NULL, return);
    lottie_set_src(obj, src, 0, true);
}


]=])
lvw_lottie_replace([=[    lv_lottie_t * lottie = (lv_lottie_t *)obj;
    return lottie->anim;]=] [=[    return lv_anim_get(obj, anim_exec_cb);]=])
lvw_lottie_replace([=[    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_exec_cb(&a, anim_exec_cb);
    lv_anim_set_var(&a, obj);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lottie->anim = lv_anim_start(&a);]=] [=[    lottie_start_anim(obj);]=])
lvw_lottie_replace([=[static void anim_exec_cb(void * var, int32_t v)
{
    lv_lottie_t * lottie = var;]=] [=[static lv_anim_t * lottie_start_anim(lv_obj_t * obj)
{
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_exec_cb(&a, anim_exec_cb);
    lv_anim_set_var(&a, obj);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_early_apply(&a, false);
    return lv_anim_start(&a);
}

static void anim_exec_cb(void * var, int32_t v)
{
    lv_lottie_t * lottie = var;
    lv_anim_t * anim = lv_anim_get(var, anim_exec_cb);]=])
# Resolve the animation from the live list after finite completion or raw deletion.
string(REPLACE "lottie->anim" "anim" LVW_LOTTIE_CODE "${LVW_LOTTIE_CODE}")
# Buffer assignment must draw even before the object's layout becomes visible.
string(REGEX MATCHALL "anim_exec_cb\\(obj, \\(int32_t\\) f_current\\)" LVW_BUFFER_UPDATES "${LVW_LOTTIE_CODE}")
list(LENGTH LVW_BUFFER_UPDATES LVW_BUFFER_UPDATE_COUNT)
if(NOT LVW_BUFFER_UPDATE_COUNT EQUAL 2)
    message(FATAL_ERROR "Expected two Lottie buffer refresh paths")
endif()
string(REPLACE "anim_exec_cb(obj, (int32_t) f_current);" "lottie_update(lottie, (int32_t) f_current);"
    LVW_LOTTIE_CODE "${LVW_LOTTIE_CODE}")
lvw_lottie_save()
