"""Render the shared label core fixture with a complete marker inventory."""

import re


CORE_DEFAULTS = {
    "LVW_IMPORT": "", "EXTRA_IMPORT": "", "MEMORY": '(memory (export "memory") 1 2)',
    "SETTER": "", "ALLOC": "i32.const 128", "FREE": "", "DISPLAY": "i32.const 100",
    "CREATE": "i32.const 300", "DEFAULT_SCREEN": "i32.const 200", "PARENT_CHECK": "",
    "FRAME": "", "REFRESH": "", "FRAME_RESULT": "i32.const 0",
}
MARKER = re.compile(r"@([A-Z_]+)@")


def render_core(template, changes=None):
    changes = changes or {}
    if set(MARKER.findall(template)) != set(CORE_DEFAULTS) or not set(changes) <= set(CORE_DEFAULTS):
        raise ValueError("label core fixture marker inventory differs")
    values = {**CORE_DEFAULTS, **changes}
    result = MARKER.sub(lambda match: values[match.group(1)], template)
    if MARKER.search(result):
        raise ValueError("label core fixture contains unresolved markers")
    return result
