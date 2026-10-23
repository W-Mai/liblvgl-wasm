# Adapt the pinned observer deletion path without modifying the source checkout.
set(LVW_OBSERVER_SOURCE "${lvgl_SOURCE_DIR}/src/core/lv_observer.c")
if(NOT EXISTS "${LVW_OBSERVER_SOURCE}")
    set(LVW_OBSERVER_SOURCE "${lvgl_SOURCE_DIR}/src/others/observer/lv_observer.c")
endif()
get_filename_component(LVW_OBSERVER_DIRECTORY "${LVW_OBSERVER_SOURCE}" DIRECTORY)
set(LVW_OBSERVER_ADAPTED "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/lv_observer.c")
set(LVW_OBSERVER_OUTPUTS "${LVW_OBSERVER_ADAPTED}")
foreach(widget IN ITEMS arc slider roller dropdown)
    list(APPEND LVW_OBSERVER_OUTPUTS "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/lv_observer_${widget}.c")
endforeach()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LVW_OBSERVER_SOURCE}")
file(SHA256 "${LVW_OBSERVER_SOURCE}" LVW_OBSERVER_HASH)
set(LVW_OBSERVER_LEGACY_SOURCES
    "0dfd9b39b6a28133f9334e7c11a85cd38edf192bd0eeca4bcf540023413923f7" # v9.0.0
    "6d46abda8c43952d0abae5087b187fe69347c43c23314eb6b09b22f3f2d7bcbc" # v9.1.0
)
set(LVW_OBSERVER_SCOPED_CLEANUP OFF)
set(LVW_OBSERVER_DEFERRED_EVENTS OFF)
set(LVW_OBSERVER_SPLIT_WIDGETS OFF)
set(LVW_OBSERVER_SUBJECT_DATA OFF)
if(LVW_OBSERVER_HASH IN_LIST LVW_OBSERVER_LEGACY_SOURCES)
    set(LVW_OBSERVER_LEGACY ON)
    list(APPEND LVW_BRIDGE_DEFINITIONS LVW_OBSERVER_DELETE=lv_observer_remove)
elseif(LVW_OBSERVER_HASH STREQUAL "4030fd4bc0fd8decd3d27cb3f7f94fd28d30acd4b26813810b77cbeb7fcf113d") # v9.2.2
    set(LVW_OBSERVER_LEGACY OFF)
    set(LVW_OBSERVER_SCOPED_CLEANUP ON)
    list(APPEND LVW_BRIDGE_DEFINITIONS LVW_OBSERVER_DELETE=lv_observer_remove)
elseif(LVW_OBSERVER_HASH STREQUAL "8793c045865b277ac994b202194ade5cbc3b3042a66ca20c93a42864518e5e4c") # v9.3.0
    set(LVW_OBSERVER_LEGACY OFF)
    set(LVW_OBSERVER_SCOPED_CLEANUP ON)
    set(LVW_OBSERVER_DEFERRED_EVENTS ON)
    list(APPEND LVW_BRIDGE_DEFINITIONS LVW_OBSERVER_DELETE=lv_observer_remove)
elseif(LVW_OBSERVER_HASH STREQUAL "f2dda22b8c18796b49b73b60f2354969826bdb4c2cffb79d400354f74ea8ac2f") # v9.4.0
    set(LVW_OBSERVER_LEGACY OFF)
    set(LVW_OBSERVER_SCOPED_CLEANUP ON)
    set(LVW_OBSERVER_DEFERRED_EVENTS ON)
    set(LVW_OBSERVER_SPLIT_WIDGETS ON)
    list(APPEND LVW_BRIDGE_DEFINITIONS LVW_OBSERVER_DELETE=lv_observer_remove)
elseif(LVW_OBSERVER_HASH STREQUAL "fd7b086123c9837ce3433c639aa828c46ec54e7ff2f8a8e57ae09586b3b51065") # v9.5.0
    set(LVW_OBSERVER_LEGACY OFF)
    set(LVW_OBSERVER_SCOPED_CLEANUP ON)
    set(LVW_OBSERVER_DEFERRED_EVENTS ON)
    set(LVW_OBSERVER_SPLIT_WIDGETS ON)
    set(LVW_OBSERVER_SUBJECT_DATA ON)
    list(APPEND LVW_BRIDGE_DEFINITIONS LVW_OBSERVER_DELETE=lv_observer_remove)
elseif(LVW_OBSERVER_HASH STREQUAL "2eb15b1668bf035e8850798cca03f365c7b36e1b1c58d53eb857ef696a3aa0ca")
    set(LVW_OBSERVER_LEGACY OFF)
    list(APPEND LVW_BRIDGE_DEFINITIONS LVW_OBSERVER_DELETE=lv_observer_delete)
else()
    file(REMOVE ${LVW_OBSERVER_OUTPUTS})
    message(FATAL_ERROR "Unsupported LVGL observer source: ${LVW_OBSERVER_SOURCE}")
endif()
if(LVW_OBSERVER_SPLIT_WIDGETS)
    # Each helper stays beside the native callback whose identity it removes.
    set(LVW_OBSERVER_WIDGET_HASH_arc "ed6347f5ff868930ef45d245a98023e8e3ae17ea6f9fa273ad40913788f0a5c5")
    set(LVW_OBSERVER_WIDGET_HASH_slider "04f85af6888db4ebcd1f27b9187c242f3395361025b0ced47eb830ce4b6134c1")
    set(LVW_OBSERVER_WIDGET_HASH_roller "91dda7dc1cfab908b9f5f665f098cbfdc2caf3fd3518c346f52ed0c72f87463e")
    set(LVW_OBSERVER_WIDGET_HASH_dropdown "3b9d793dbe4ac37c7879d2b1b93e8df12db4602d7d6ff6a37712d4064ed45f6c")
    if(LVW_OBSERVER_SUBJECT_DATA)
        set(LVW_OBSERVER_WIDGET_HASH_arc "9213be494f8654290141e8af66bdbd489c921ab26b039c23ce35c9c0f657de87")
        set(LVW_OBSERVER_WIDGET_HASH_slider "b8317769478790feaeb45c085904b3fcdbcd09c90535ed2c140b9ac0edc0a332")
        set(LVW_OBSERVER_WIDGET_HASH_roller "9f2071ecfadb3609836230756795bb843d7eb23fa26096c4a9a903a8ff20f0d5")
        set(LVW_OBSERVER_WIDGET_HASH_dropdown "c1398896bb08486daaca662a630827f9eed02c6380e22bfa367572c3789ef013")
    endif()
    foreach(widget IN ITEMS arc slider roller dropdown)
        set(source "${lvgl_SOURCE_DIR}/src/widgets/${widget}/lv_${widget}.c")
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${source}")
        set(hash "")
        if(EXISTS "${source}")
            file(SHA256 "${source}" hash)
        endif()
        if(NOT hash STREQUAL LVW_OBSERVER_WIDGET_HASH_${widget})
            file(REMOVE ${LVW_OBSERVER_OUTPUTS})
            message(FATAL_ERROR "Unsupported LVGL observer source: ${source}")
        endif()
    endforeach()
endif()
file(READ "${LVW_OBSERVER_SOURCE}" LVW_OBSERVER_CODE)
foreach(LVW_ANCHOR IN ITEMS "#if LV_USE_OBSERVER\n" "    lv_free(observer);\n")
    string(FIND "${LVW_OBSERVER_CODE}" "${LVW_ANCHOR}" LVW_FIRST)
    string(FIND "${LVW_OBSERVER_CODE}" "${LVW_ANCHOR}" LVW_LAST REVERSE)
    if(LVW_FIRST LESS 0 OR NOT LVW_FIRST EQUAL LVW_LAST)
        file(REMOVE "${LVW_OBSERVER_ADAPTED}")
        message(FATAL_ERROR "LVGL observer adaptation requires a unique source anchor")
    endif()
endforeach()
string(REPLACE "#if LV_USE_OBSERVER\n"
    "#if LV_USE_OBSERVER\n\nvoid lvw_observer_release_native(lv_observer_t * observer);\n"
    LVW_OBSERVER_CODE "${LVW_OBSERVER_CODE}")
string(REPLACE "    lv_free(observer);\n"
    "    lvw_observer_release_native(observer);\n    lv_free(observer);\n"
    LVW_OBSERVER_CODE "${LVW_OBSERVER_CODE}")
if(LVW_OBSERVER_LEGACY)
    # Each object's deletion event owns one observer; widget events own a subject.
    string(FIND "${LVW_OBSERVER_CODE}" "    while(lv_obj_remove_event_cb(obj, unsubscribe_on_delete_cb));" LVW_BEGIN)
    string(FIND "${LVW_OBSERVER_CODE}" "    lv_observer_t * observer = _lv_ll_get_head(&subject->subs_ll);" LVW_END)
    if(LVW_BEGIN LESS 0 OR LVW_END LESS LVW_BEGIN)
        message(FATAL_ERROR "LVGL observer adaptation requires the native unbind anchors")
    endif()
    math(EXPR LVW_LENGTH "${LVW_END} - ${LVW_BEGIN}")
    string(SUBSTRING "${LVW_OBSERVER_CODE}" ${LVW_BEGIN} ${LVW_LENGTH} LVW_UNBIND)
    set(LVW_REPLACEMENT "")
    foreach(widget IN ITEMS BUTTON ARC SLIDER ROLLER DROPDOWN)
        string(TOLOWER "${widget}" callback)
        if(widget STREQUAL "BUTTON")
            set(callback btn)
        endif()
        string(APPEND LVW_REPLACEMENT
            "#if LV_USE_${widget}\n    lv_obj_remove_event_cb_with_user_data(obj, ${callback}_value_changed_event_cb, subject);\n#endif\n")
    endforeach()
    string(REPLACE "${LVW_UNBIND}" "${LVW_REPLACEMENT}\n" LVW_OBSERVER_CODE "${LVW_OBSERVER_CODE}")
    string(REPLACE "        if(observer->target == obj) {\n"
        "        if(observer->target == obj) {\n            lv_obj_remove_event_cb_with_user_data(obj, unsubscribe_on_delete_cb, observer);\n"
        LVW_OBSERVER_CODE "${LVW_OBSERVER_CODE}")
endif()
if(LVW_OBSERVER_SCOPED_CLEANUP)
    if(LVW_OBSERVER_SUBJECT_DATA)
        # External data belongs to the subject, independent of its observers.
        set(LVW_DATA_RELEASE [=[#if LV_USE_EXT_DATA
    if(observer->subject->ext_data.free_cb) {
        observer->subject->ext_data.free_cb(observer->subject->ext_data.data);
        observer->subject->ext_data.data = NULL;
    }
#endif

]=])
        string(FIND "${LVW_OBSERVER_CODE}" "${LVW_DATA_RELEASE}" LVW_FIRST)
        string(FIND "${LVW_OBSERVER_CODE}" "${LVW_DATA_RELEASE}" LVW_LAST REVERSE)
        if(LVW_FIRST LESS 0 OR NOT LVW_FIRST EQUAL LVW_LAST)
            file(REMOVE ${LVW_OBSERVER_OUTPUTS})
            message(FATAL_ERROR "LVGL subject cleanup requires a unique external-data release")
        endif()
        string(REPLACE "${LVW_DATA_RELEASE}" "" LVW_OBSERVER_CODE "${LVW_OBSERVER_CODE}")
    endif()
    # Both subject deinit and explicit unbinding use the same scoped cleanup.
    set(LVW_DEINIT [=[static void lvw_observer_unbind_widget(lv_obj_t * obj, lv_subject_t * subject);

void lv_subject_deinit(lv_subject_t * subject)
{
    lv_observer_t * observer;
    while((observer = lv_ll_get_head(&subject->subs_ll)) != NULL) {
        if(observer->for_obj && observer->target) {
            lv_obj_remove_event_cb_with_user_data(observer->target, unsubscribe_on_delete_cb, observer);
            lvw_observer_unbind_widget(observer->target, subject);
        }
        lv_observer_remove(observer);
    }
}

]=])
    set(LVW_UNBIND [=[static void lvw_observer_unbind_widget(lv_obj_t * obj, lv_subject_t * subject)
{
    lv_obj_remove_event_cb_with_user_data(obj, obj_value_changed_event_cb, subject);
]=])
    if(LVW_OBSERVER_SUBJECT_DATA)
        set(LVW_DATA_RELEASE [=[#if LV_USE_EXT_DATA
    void (*free_cb)(void *) = subject->ext_data.free_cb;
    void * data = subject->ext_data.data;
    subject->ext_data.free_cb = NULL;
    subject->ext_data.data = NULL;
    if(free_cb) free_cb(data);
#endif
]=])
        string(REPLACE "        lv_observer_remove(observer);\n    }\n"
            "        lv_observer_remove(observer);\n    }\n${LVW_DATA_RELEASE}"
            LVW_DEINIT "${LVW_DEINIT}")
    endif()
    foreach(widget IN ITEMS ARC SLIDER ROLLER DROPDOWN)
        string(TOLOWER "${widget}" callback)
        if(LVW_OBSERVER_SPLIT_WIDGETS)
            string(PREPEND LVW_UNBIND
                "#if LV_USE_${widget}\nvoid lvw_observer_unbind_${callback}(lv_obj_t * obj, lv_subject_t * subject);\n#endif\n")
            string(APPEND LVW_UNBIND
                "#if LV_USE_${widget}\n    lvw_observer_unbind_${callback}(obj, subject);\n#endif\n")
        else()
            string(APPEND LVW_UNBIND
                "#if LV_USE_${widget}\n    lv_obj_remove_event_cb_with_user_data(obj, ${callback}_value_changed_event_cb, subject);\n#endif\n")
        endif()
    endforeach()
    string(APPEND LVW_UNBIND [=[}

void lv_obj_remove_from_subject(lv_obj_t * obj, lv_subject_t * subject)
{
    uint32_t i = 0;
    while(i < lv_obj_get_event_count(obj)) {
        lv_event_dsc_t * event_dsc = lv_obj_get_event_dsc(obj, i);
        if(event_dsc->cb == unsubscribe_on_delete_cb) {
            lv_observer_t * observer = event_dsc->user_data;
            if(subject == NULL || subject == observer->subject) {
                lv_subject_t * selected = observer->subject;
                lv_obj_remove_event(obj, i);
                lvw_observer_unbind_widget(obj, selected);
                lv_observer_remove(observer);
                /* Widget callbacks can precede this event in the array. */
                i = 0;
                continue;
            }
        }
        i++;
    }
}

]=])
    if(LVW_OBSERVER_DEFERRED_EVENTS)
        # Removed descriptors stay in the array until the outer event returns.
        string(REPLACE "if(event_dsc->cb == unsubscribe_on_delete_cb)"
            "if(event_dsc->cb == unsubscribe_on_delete_cb && !(event_dsc->filter & LV_EVENT_MARKED_DELETING))"
            LVW_UNBIND "${LVW_UNBIND}")
        string(REPLACE "lv_obj_remove_event_cb_with_user_data(observer->target, NULL, observer->subject);"
            "lvw_observer_unbind_widget(observer->target, observer->subject);"
            LVW_OBSERVER_CODE "${LVW_OBSERVER_CODE}")
    endif()
    foreach(function IN ITEMS DEINIT UNBIND)
        if(function STREQUAL "DEINIT")
            set(LVW_BEGIN_ANCHOR "void lv_subject_deinit(lv_subject_t * subject)\n")
            set(LVW_END_ANCHOR "lv_subject_t * lv_subject_get_group_element(")
        else()
            set(LVW_BEGIN_ANCHOR "void lv_obj_remove_from_subject(lv_obj_t * obj, lv_subject_t * subject)\n")
            set(LVW_END_ANCHOR "void * lv_observer_get_target(")
        endif()
        foreach(anchor IN ITEMS BEGIN END)
            string(FIND "${LVW_OBSERVER_CODE}" "${LVW_${anchor}_ANCHOR}" LVW_${anchor})
            string(FIND "${LVW_OBSERVER_CODE}" "${LVW_${anchor}_ANCHOR}" LVW_LAST REVERSE)
            if(LVW_${anchor} LESS 0 OR NOT LVW_${anchor} EQUAL LVW_LAST)
                message(FATAL_ERROR "LVGL observer cleanup requires unique function anchors")
            endif()
        endforeach()
        if(LVW_END LESS LVW_BEGIN)
            message(FATAL_ERROR "LVGL observer cleanup requires ordered function anchors")
        endif()
        math(EXPR LVW_LENGTH "${LVW_END} - ${LVW_BEGIN}")
        string(SUBSTRING "${LVW_OBSERVER_CODE}" ${LVW_BEGIN} ${LVW_LENGTH} LVW_ORIGINAL)
        string(REPLACE "${LVW_ORIGINAL}" "${LVW_${function}}" LVW_OBSERVER_CODE "${LVW_OBSERVER_CODE}")
    endforeach()
endif()
file(CONFIGURE OUTPUT "${LVW_OBSERVER_ADAPTED}" CONTENT "${LVW_OBSERVER_CODE}" @ONLY)

get_target_property(LVW_LVGL_SOURCES lvgl SOURCES)
list(FIND LVW_LVGL_SOURCES "${LVW_OBSERVER_SOURCE}" LVW_OBSERVER_INDEX)
list(LENGTH LVW_LVGL_SOURCES LVW_BEFORE)
list(REMOVE_ITEM LVW_LVGL_SOURCES "${LVW_OBSERVER_SOURCE}")
list(LENGTH LVW_LVGL_SOURCES LVW_AFTER)
math(EXPR LVW_REMOVED "${LVW_BEFORE} - ${LVW_AFTER}")
if(NOT LVW_REMOVED EQUAL 1)
    message(FATAL_ERROR "Expected one LVGL observer compilation unit")
endif()
list(INSERT LVW_LVGL_SOURCES ${LVW_OBSERVER_INDEX} "${LVW_OBSERVER_ADAPTED}")
set_property(TARGET lvgl PROPERTY SOURCES "${LVW_LVGL_SOURCES}")
set_source_files_properties("${LVW_OBSERVER_ADAPTED}" TARGET_DIRECTORY lvgl
    PROPERTIES INCLUDE_DIRECTORIES "${LVW_OBSERVER_DIRECTORY}")
if(LVW_OBSERVER_SPLIT_WIDGETS)
    foreach(widget IN ITEMS arc slider roller dropdown)
        set(directory "${lvgl_SOURCE_DIR}/src/widgets/${widget}")
        set(source "${directory}/lv_${widget}.c")
        set(adapted "${CMAKE_CURRENT_BINARY_DIR}/lvgl-adapted/lv_observer_${widget}.c")
        file(READ "${source}" code)
        string(TOUPPER "${widget}" feature)
        string(APPEND code
            "\n#if LV_USE_${feature} && LV_USE_OBSERVER\nvoid lvw_observer_unbind_${widget}(lv_obj_t * obj, lv_subject_t * subject)\n{\n    lv_obj_remove_event_cb_with_user_data(obj, ${widget}_value_changed_event_cb, subject);\n}\n#endif\n")
        file(CONFIGURE OUTPUT "${adapted}" CONTENT "${code}" @ONLY)
        list(FIND LVW_LVGL_SOURCES "${source}" index)
        list(LENGTH LVW_LVGL_SOURCES before)
        list(REMOVE_ITEM LVW_LVGL_SOURCES "${source}")
        list(LENGTH LVW_LVGL_SOURCES after)
        math(EXPR removed "${before} - ${after}")
        if(NOT removed EQUAL 1)
            message(FATAL_ERROR "Expected one LVGL ${widget} compilation unit")
        endif()
        list(INSERT LVW_LVGL_SOURCES ${index} "${adapted}")
        set_source_files_properties("${adapted}" TARGET_DIRECTORY lvgl
            PROPERTIES INCLUDE_DIRECTORIES "${directory}")
    endforeach()
    set_property(TARGET lvgl PROPERTY SOURCES "${LVW_LVGL_SOURCES}")
endif()
