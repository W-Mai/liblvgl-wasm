use std::error::Error;
use std::path::PathBuf;

use wasmtime::{Caller, Engine, Linker, Memory, Module, Store};
use wasmtime_wasi::WasiCtxBuilder;
use wasmtime_wasi::p1::{self, WasiP1Ctx};

struct Host {
    wasi: WasiP1Ctx,
    clicks: u32,
}

fn put_u32(
    memory: &Memory,
    store: &mut Store<Host>,
    pointer: i32,
    offset: usize,
    value: u32,
) -> Result<(), Box<dyn Error>> {
    memory.write(store, pointer as usize + offset, &value.to_le_bytes())?;
    Ok(())
}

fn get_u32(
    memory: &Memory,
    store: &mut Store<Host>,
    pointer: i32,
    offset: usize,
) -> Result<u32, Box<dyn Error>> {
    let mut bytes = [0; 4];
    memory.read(store, pointer as usize + offset, &mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/wasm/liblvgl.wasm"));
    let engine = Engine::default();
    let module = Module::from_file(&engine, &path)?;
    let mut linker = Linker::<Host>::new(&engine);
    p1::add_to_linker_sync(&mut linker, |host| &mut host.wasi)?;
    linker.func_wrap(
        "lvw",
        "event",
        |mut caller: Caller<'_, Host>, callback_id: i32, _object: i32, _code: i32| {
            if callback_id == 1 {
                caller.data_mut().clicks += 1;
            }
        },
    )?;
    let mut store = Store::new(
        &engine,
        Host {
            wasi: WasiCtxBuilder::new().inherit_stdio().build_p1(),
            clicks: 0,
        },
    );
    let instance = linker.instantiate(&mut store, &module)?;
    let memory = instance
        .get_memory(&mut store, "memory")
        .ok_or("missing memory")?;
    instance
        .get_typed_func::<(), ()>(&mut store, "_initialize")?
        .call(&mut store, ())?;
    let abi = instance.get_typed_func::<(), i32>(&mut store, "lvw_abi_version")?;
    assert_eq!(abi.call(&mut store, ())?, 1);
    let init = instance.get_typed_func::<(), i32>(&mut store, "lvw_init")?;
    assert_eq!(init.call(&mut store, ())?, 0);

    let display_create =
        instance.get_typed_func::<(i32, i32, i32), i32>(&mut store, "lvw_display_create")?;
    let display = display_create.call(&mut store, (320, 240, 1))?;
    assert_ne!(display, 0);
    let indev_create =
        instance.get_typed_func::<(i32, i32), i32>(&mut store, "lvw_indev_create")?;
    let pointer = indev_create.call(&mut store, (display, 1))?;
    assert_ne!(pointer, 0);

    let screen = instance
        .get_typed_func::<i32, i32>(&mut store, "lv_display_get_screen_active")?
        .call(&mut store, display)?;
    let alloc = instance.get_typed_func::<i32, i32>(&mut store, "lvw_alloc")?;
    let free = instance.get_typed_func::<i32, ()>(&mut store, "lvw_free")?;
    let resource = include_bytes!("../../../examples/browser/red.bmp");
    let name = alloc.call(&mut store, 8)?;
    memory.write(&mut store, name as usize, b"red.bmp\0")?;
    let data = alloc.call(&mut store, resource.len() as i32)?;
    memory.write(&mut store, data as usize, resource)?;
    assert_eq!(
        instance
            .get_typed_func::<(i32, i32, i32, i32), i32>(&mut store, "lvw_resource_put")?
            .call(&mut store, (name, 7, data, resource.len() as i32))?,
        0
    );
    free.call(&mut store, data)?;
    free.call(&mut store, name)?;
    let image_path = alloc.call(&mut store, 10)?;
    memory.write(&mut store, image_path as usize, b"W:red.bmp\0")?;
    let image = instance
        .get_typed_func::<i32, i32>(&mut store, "lv_image_create")?
        .call(&mut store, screen)?;
    instance
        .get_typed_func::<(i32, i32), ()>(&mut store, "lv_image_set_src")?
        .call(&mut store, (image, image_path))?;
    instance
        .get_typed_func::<(i32, i32, i32), ()>(&mut store, "lv_obj_set_pos")?
        .call(&mut store, (image, 8, 8))?;
    let button = instance
        .get_typed_func::<i32, i32>(&mut store, "lv_button_create")?
        .call(&mut store, screen)?;
    instance
        .get_typed_func::<(i32, i32, i32), ()>(&mut store, "lv_obj_set_size")?
        .call(&mut store, (button, 140, 60))?;
    instance
        .get_typed_func::<(i32, i32, i32), ()>(&mut store, "lv_obj_set_pos")?
        .call(&mut store, (button, 90, 80))?;
    let clicked_code = instance
        .get_typed_func::<(), i32>(&mut store, "lvw_event_clicked")?
        .call(&mut store, ())?;
    let event_add = instance.get_typed_func::<(i32, i32, i32), i32>(&mut store, "lvw_event_add")?;
    assert_eq!(event_add.call(&mut store, (button, clicked_code, 1))?, 0);

    let result = alloc.call(&mut store, 16)?;
    put_u32(&memory, &mut store, result, 0, 16)?;
    put_u32(&memory, &mut store, result, 4, 1)?;
    let step = instance.get_typed_func::<(i32, i32), i32>(&mut store, "lvw_step")?;
    for _ in 0..5 {
        assert_eq!(step.call(&mut store, (50, result))?, 0);
    }

    let packet = alloc.call(&mut store, 32)?;
    put_u32(&memory, &mut store, packet, 0, 32)?;
    put_u32(&memory, &mut store, packet, 4, 1)?;
    put_u32(&memory, &mut store, packet, 8, 1)?;
    put_u32(&memory, &mut store, packet, 12, 120)?;
    put_u32(&memory, &mut store, packet, 16, 100)?;
    let indev_push =
        instance.get_typed_func::<(i32, i32, i32), i32>(&mut store, "lvw_indev_push")?;
    put_u32(&memory, &mut store, packet, 20, 1)?;
    assert_eq!(indev_push.call(&mut store, (pointer, packet, 32))?, 0);
    assert_eq!(step.call(&mut store, (50, result))?, 0);
    put_u32(&memory, &mut store, packet, 20, 0)?;
    assert_eq!(indev_push.call(&mut store, (pointer, packet, 32))?, 0);
    assert_eq!(step.call(&mut store, (50, result))?, 0);
    assert_eq!(store.data().clicks, 1);

    let frame = alloc.call(&mut store, 48)?;
    put_u32(&memory, &mut store, frame, 0, 48)?;
    put_u32(&memory, &mut store, frame, 4, 1)?;
    assert_eq!(
        instance
            .get_typed_func::<(i32, i32), i32>(&mut store, "lvw_frame_get")?
            .call(&mut store, (display, frame))?,
        0
    );
    assert!(get_u32(&memory, &mut store, frame, 44)? > 0);
    let pixels = get_u32(&memory, &mut store, frame, 8)? as usize;
    let length = get_u32(&memory, &mut store, frame, 12)? as usize;
    assert_eq!(length, 320 * 240 * 4);
    assert!(
        memory.data(&store)[pixels..pixels + length]
            .iter()
            .any(|byte| *byte != 0)
    );
    let red = pixels + (8 * 320 + 8) * 4;
    assert_eq!(&memory.data(&store)[red..red + 3], &[0, 0, 255]);

    free.call(&mut store, frame)?;
    free.call(&mut store, packet)?;
    free.call(&mut store, result)?;
    assert_eq!(
        instance
            .get_typed_func::<i32, i32>(&mut store, "lvw_display_destroy")?
            .call(&mut store, display)?,
        0
    );
    free.call(&mut store, image_path)?;
    assert_eq!(
        instance
            .get_typed_func::<(), i32>(&mut store, "lvw_shutdown")?
            .call(&mut store, ())?,
        0
    );
    println!("rust host passed: click count {}", store.data().clicks);
    Ok(())
}
