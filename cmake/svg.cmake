# Adapt the pinned SVG parser, viewport and decoder in the build directory.
function(lvw_svg_load name hash)
    set(source "${lvgl_SOURCE_DIR}/src/image/svg/${name}.c")
    if(ARGC GREATER 2)
        set(source "${lvgl_SOURCE_DIR}/${ARGV2}")
    endif()
    set(adapted "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/${name}.c")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${source}")
    file(SHA256 "${source}" actual)
    if(NOT actual STREQUAL hash)
        file(REMOVE "${adapted}")
        message(FATAL_ERROR "Unsupported LVGL SVG source: ${source}")
    endif()
    file(READ "${source}" code)
    set(LVW_SVG_SOURCE "${source}" PARENT_SCOPE)
    set(LVW_SVG_ADAPTED "${adapted}" PARENT_SCOPE)
    set(LVW_SVG_CODE "${code}" PARENT_SCOPE)
endfunction()

function(lvw_svg_anchor anchor output)
    string(FIND "${LVW_SVG_CODE}" "${anchor}" first)
    string(FIND "${LVW_SVG_CODE}" "${anchor}" last REVERSE)
    if(first LESS 0 OR NOT first EQUAL last)
        file(REMOVE "${LVW_SVG_ADAPTED}")
        message(FATAL_ERROR "LVGL SVG adaptation requires a unique source anchor")
    endif()
    set(${output} ${first} PARENT_SCOPE)
endfunction()

function(lvw_svg_replace before after)
    lvw_svg_anchor("${before}" first)
    string(REPLACE "${before}" "${after}" code "${LVW_SVG_CODE}")
    set(LVW_SVG_CODE "${code}" PARENT_SCOPE)
endfunction()

function(lvw_svg_replace_region begin end replacement)
    lvw_svg_anchor("${begin}" first)
    lvw_svg_anchor("${end}" last)
    if(NOT first LESS last)
        message(FATAL_ERROR "Invalid LVGL SVG source region")
    endif()
    string(SUBSTRING "${LVW_SVG_CODE}" 0 ${first} prefix)
    string(SUBSTRING "${LVW_SVG_CODE}" ${last} -1 suffix)
    set(LVW_SVG_CODE "${prefix}${replacement}${suffix}" PARENT_SCOPE)
endfunction()

function(lvw_svg_save)
    file(CONFIGURE OUTPUT "${LVW_SVG_ADAPTED}" CONTENT "${LVW_SVG_CODE}" @ONLY)
    get_target_property(sources lvgl SOURCES)
    list(FIND sources "${LVW_SVG_SOURCE}" index)
    list(LENGTH sources before)
    list(REMOVE_ITEM sources "${LVW_SVG_SOURCE}")
    list(LENGTH sources after)
    math(EXPR removed "${before} - ${after}")
    if(NOT removed EQUAL 1)
        message(FATAL_ERROR "Expected one LVGL compilation unit: ${LVW_SVG_SOURCE}")
    endif()
    list(INSERT sources ${index} "${LVW_SVG_ADAPTED}")
    set_property(TARGET lvgl PROPERTY SOURCES "${sources}")
    get_filename_component(source_directory "${LVW_SVG_SOURCE}" DIRECTORY)
    set_source_files_properties("${LVW_SVG_ADAPTED}" TARGET_DIRECTORY lvgl
        PROPERTIES INCLUDE_DIRECTORIES "${source_directory}")
endfunction()

lvw_svg_load(lv_svg_token 29aa67e8f479930e590b07bab6528dc1aa5dc86b5cb371f6dd08de26966488fd)
# All four scanners share the same end-exclusive contract.
string(REGEX MATCHALL "while\\(state->cur <= state->end\\)" LVW_SVG_LOOPS "${LVW_SVG_CODE}")
list(LENGTH LVW_SVG_LOOPS LVW_SVG_LOOP_COUNT)
if(NOT LVW_SVG_LOOP_COUNT EQUAL 4)
    message(FATAL_ERROR "Expected four SVG token scanners")
endif()
string(REPLACE "while(state->cur <= state->end)" "while(state->cur < state->end)"
    LVW_SVG_CODE "${LVW_SVG_CODE}")
lvw_svg_replace([=[                    if(ch == '/') {
                        token->type = LV_SVG_TOKEN_END;
]=] [=[                    if(ch == '/' && token->start && token->type == LV_SVG_TOKEN_BEGIN) {
                        token->end = state->cur;
                        token->flat = true;
                        _set_tag_state(state, SVG_ATTR_START);
                        state->cur++;
                        continue;
                    }
                    if(ch == '/') {
                        token->type = LV_SVG_TOKEN_END;
]=])
lvw_svg_replace([=[                        if(state.cur == state.end) {
                            goto finish;
                        }
]=] "")
lvw_svg_replace([=[finish:
    lv_array_deinit(&token.attrs);
    return true;
]=] [=[    bool complete = !_special_handle(&state) &&
                    _lv_svg_token_process(&token, cb, user_data);
    lv_array_deinit(&token.attrs);
    return complete;
]=])
lvw_svg_save()

lvw_svg_load(lv_svg_parser 511efc001f43894308b43aedf81e8383a3ef74844e7dd7e2485116313704800e)
lvw_svg_replace([=[    if(parser->cur_node->type != tag) {]=]
    [=[    if(!parser->cur_node || parser->cur_node->type != tag) {]=])
lvw_svg_replace([=[    if(parser->cur_node != parser->doc_root) {
        parser->cur_node = (lv_svg_node_t *)LV_TREE_NODE(parser->cur_node)->parent;
    }
]=] [=[    parser->cur_node = (lv_svg_node_t *)LV_TREE_NODE(parser->cur_node)->parent;
]=])
lvw_svg_replace([=[           && (parser->cur_node == parser->doc_root)]=]
    [=[           && (parser->cur_node == NULL)]=])
lvw_svg_replace([=[    lv_svg_tag_t tag = _get_svg_tag_type(token);

    if(parser->doc_root == NULL) {]=] [=[    lv_svg_tag_t tag = _get_svg_tag_type(token);

    /* Only whitespace may appear outside the single root element. */
    if(!parser->cur_node && token->type == LV_SVG_TOKEN_CONTENT) {
        for(const char * p = token->start; p < token->end; p++) {
            if(!isspace((unsigned char)*p)) return false;
        }
        return true;
    }
    if(parser->doc_root && !parser->cur_node) return false;

    if(parser->doc_root == NULL) {]=])
lvw_svg_replace([=[    else if(type == LV_SVG_ATTR_GRADIENT_STOP_OFFSET) {
        float val = 0.0f;
        val_start = _parse_number(val_start, val_end, &val);
        attr->value.fval = val;
    }
]=] [=[    else if(type == LV_SVG_ATTR_GRADIENT_STOP_OFFSET) {
        float val = 0.0f;
        val_start = _parse_number(val_start, val_end, &val);
        if(val_start && val_start < val_end && *val_start == '%') val *= 0.01f;
        attr->value.fval = LV_CLAMP(0.0f, val, 1.0f);
    }
]=])
lvw_svg_save()

lvw_svg_load(lv_svg_render a8ccd5e0f3c8639494155d07cfcd28d164875f6b83dcced47aa549b4fc6d23f4)
lvw_svg_replace([=[    uint32_t len = lv_array_size(&node->attrs);
    for(uint32_t i = 0; i < len; i++) {
        lv_svg_attr_t * attr = lv_array_at(&node->attrs, i);
        obj->clz->set_attr(obj, &(state->draw_dsc->dsc), attr);
    }
]=] [=[    const lv_svg_attr_t * viewbox = NULL;
    uint32_t len = lv_array_size(&node->attrs);
    for(uint32_t i = 0; i < len; i++) {
        lv_svg_attr_t * attr = lv_array_at(&node->attrs, i);
        if(node->type == LV_SVG_TAG_SVG && attr->id == LV_SVG_ATTR_VIEWBOX) {
            viewbox = attr;
            continue;
        }
        obj->clz->set_attr(obj, &(state->draw_dsc->dsc), attr);
    }
    /* Dimensions must be available regardless of XML attribute order. */
    if(viewbox) obj->clz->set_attr(obj, &(state->draw_dsc->dsc), viewbox);
]=])
lvw_svg_save()

lvw_svg_load(lv_svg_decoder fb3543e2c4cf3f687ed7f48faac2bdb8fa281ec25f5202bd2a81111360c30076)
lvw_svg_replace_region([=[static bool valid_svg_data(]=]
    [=[static lv_result_t svg_decoder_open(lv_image_decoder_t * decoder, lv_image_decoder_dsc_t * dsc)
{]=] [=[static lv_svg_render_obj_t * svg_load(const uint8_t * data, uint32_t size)
{
    if(!data || !size) return NULL;
    while(size && (*data == ' ' || *data == '\t' || *data == '\r' || *data == '\n')) {
        data++;
        size--;
    }
    if(!((size >= 4 && lv_memcmp(data, "<svg", 4) == 0) ||
         (size >= 5 && lv_memcmp(data, "<?xml", 5) == 0))) return NULL;
    lv_svg_node_t * doc = lv_svg_load_data((const char *)data, size);
    if(!doc) return NULL;
    lv_svg_render_obj_t * render = lv_svg_render_create(doc);
    lv_svg_node_delete(doc);
    return render;
}

static lv_result_t svg_decoder_info(lv_image_decoder_t * decoder, lv_image_decoder_dsc_t * src,
                                    lv_image_header_t * header)
{
    uint8_t * file_data = NULL;
    const uint8_t * data;
    uint32_t size;
    float width = 0;
    float height = 0;
    if(src->src_type == LV_IMAGE_SRC_FILE) {
        if(lv_strcmp(lv_fs_get_ext(src->src), "svg")) return LV_RESULT_INVALID;
        file_data = alloc_file(src->src, &size);
        data = file_data;
    }
    else if(src->src_type == LV_IMAGE_SRC_VARIABLE) {
        const lv_image_dsc_t * image = src->src;
        data = image->data;
        size = image->data_size;
        width = image->header.w;
        height = image->header.h;
    }
    else return LV_RESULT_INVALID;

    lv_svg_render_obj_t * render = svg_load(data, size);
    lv_free(file_data);
    if(!render) return LV_RESULT_INVALID;
    if(src->src_type == LV_IMAGE_SRC_FILE) {
        lv_svg_render_get_viewport_size(render, &width, &height);
    }
    lv_svg_render_delete(render);

    /* The image header stores dimensions and ARGB stride in 16-bit fields. */
    if(!(width >= 1 && width <= UINT16_MAX / 4 && height >= 1 && height <= UINT16_MAX)) {
        return LV_RESULT_INVALID;
    }
    header->cf = LV_COLOR_FORMAT_ARGB8888;
    header->w = (uint16_t)width;
    header->h = (uint16_t)height;
    header->stride = header->w * 4;
    header->flags |= LV_IMAGE_FLAGS_CUSTOM_DRAW;
    decoder->custom_draw_cb = svg_draw;
    return LV_RESULT_OK;
}

]=])
lvw_svg_replace([=[    lv_svg_node_t * svg_doc = lv_svg_load_data((char *)svg_data, svg_data_size);
    lv_svg_render_obj_t * draw_list = lv_svg_render_create(svg_doc);
]=] [=[    lv_svg_render_obj_t * draw_list = svg_load(svg_data, svg_data_size);
]=])
lvw_svg_replace([=[    lv_svg_node_delete(svg_doc);

    /* create a fake draw_buf object */
    lv_draw_buf_t * draw_buf = lv_zalloc(sizeof(lv_draw_buf_t));
]=] [=[    if(!draw_list) {
        LV_PROFILER_DECODER_END_TAG("lv_svg_decoder_open");
        return LV_RESULT_INVALID;
    }

    /* The custom buffer owns the render list through its free handler. */
    lv_draw_buf_t * draw_buf = lv_zalloc(sizeof(lv_draw_buf_t));
    if(!draw_buf) {
        lv_svg_render_delete(draw_list);
        LV_PROFILER_DECODER_END_TAG("lv_svg_decoder_open");
        return LV_RESULT_INVALID;
    }
]=])
lvw_svg_replace([=[        if(entry == NULL) {
            lv_draw_buf_destroy(draw_buf);
]=] [=[        if(entry == NULL) {
            lv_draw_buf_destroy(draw_buf);
            dsc->decoded = NULL;
]=])
lvw_svg_replace_region([=[        int32_t off_x = (lv_area_get_width(coords) - (int32_t)image_dsc->header.w - 1) / 2;]=]
    [=[        lv_matrix_translate(&matrix, image_dsc->pivot.x, image_dsc->pivot.y);]=] "")
lvw_svg_save()

lvw_svg_load(lv_draw_image eda7a142395efcb4abe16a32e1613dbc823bff5373ccabd393321594b0b5bdfc src/draw/lv_draw_image.c)
lvw_svg_replace([=[    lv_point_t p[4] = {
        {0, 0},
        {w - 1, 0},
        {0, h - 1},
        {w - 1, h - 1},
    };]=] [=[    /* Bound complete pixel cells, including the final scaled row/column. */
    lv_point_t p[4] = {
        {0, 0},
        {w, 0},
        {0, h},
        {w, h},
    };]=])
lvw_svg_replace([=[    res->x1 = LV_MIN4(p[0].x, p[1].x, p[2].x, p[3].x);
    res->x2 = LV_MAX4(p[0].x, p[1].x, p[2].x, p[3].x);
    res->y1 = LV_MIN4(p[0].y, p[1].y, p[2].y, p[3].y);
    res->y2 = LV_MAX4(p[0].y, p[1].y, p[2].y, p[3].y);
]=] [=[    /* One pixel includes integer transform rounding and inclusive draw bounds. */
    res->x1 = LV_MIN4(p[0].x, p[1].x, p[2].x, p[3].x) - 1;
    res->x2 = LV_MAX4(p[0].x, p[1].x, p[2].x, p[3].x) + 1;
    res->y1 = LV_MIN4(p[0].y, p[1].y, p[2].y, p[3].y) - 1;
    res->y2 = LV_MAX4(p[0].y, p[1].y, p[2].y, p[3].y) + 1;
]=])
lvw_svg_replace_region([=[        if(decoder_dsc.decoder && decoder_dsc.decoder->custom_draw_cb) {]=]
    [=[        lv_image_decoder_close(&decoder_dsc);]=] [=[        if(decoder_dsc.decoder && decoder_dsc.decoder->custom_draw_cb) {
            /* Keep source coordinates unchanged and intersect the transformed bounds
             * with the current layer clip. No object is required for a draw descriptor. */
            lv_area_t clip_area;
            lv_image_buf_get_transformed_area(&clip_area, lv_area_get_width(coords), lv_area_get_height(coords),
                                              dsc->rotation, dsc->scale_x, dsc->scale_y, &dsc->pivot);
            lv_area_move(&clip_area, coords->x1, coords->y1);
            if(lv_area_intersect(&clip_area, &clip_area, &layer->_clip_area) &&
               lv_area_intersect(&clip_area, &clip_area, &layer->buf_area)) {
                decoder_dsc.decoder->custom_draw_cb(layer, &decoder_dsc, coords, &new_image_dsc, &clip_area);
            }
        }

]=])
lvw_svg_save()
