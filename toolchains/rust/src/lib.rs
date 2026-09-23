#![no_std]

use core::sync::atomic::{AtomicU32, Ordering};

static LABEL: AtomicU32 = AtomicU32::new(0);

#[link(wasm_import_module = "lvw_app")]
unsafe extern "C" {
    fn screen() -> u32;
    fn button(parent: u32) -> u32;
    fn label(parent: u32) -> u32;
    fn set_size(object: u32, width: i32, height: i32);
    fn set_pos(object: u32, x: i32, y: i32);
    fn set_text(object: u32, pointer: u32, length: u32) -> i32;
    fn on_click(object: u32, callback_id: u32) -> i32;
    fn log(pointer: u32, length: u32);
}

fn write_text(object: u32, value: &'static [u8]) {
    unsafe { set_text(object, value.as_ptr() as u32, value.len() as u32) };
}

#[unsafe(no_mangle)]
pub extern "C" fn app_abi_version() -> u32 {
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn app_init() {
    unsafe {
        let item = button(screen());
        set_size(item, 180, 64);
        set_pos(item, 70, 88);
        let text = label(item);
        LABEL.store(text, Ordering::Relaxed);
        write_text(text, b"Rust application");
        on_click(item, 1);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn app_event(callback_id: u32, _event_code: u32) {
    if callback_id == 1 {
        write_text(LABEL.load(Ordering::Relaxed), b"Rust clicked");
        unsafe { log(b"Rust clicked".as_ptr() as u32, 12) };
    }
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}
