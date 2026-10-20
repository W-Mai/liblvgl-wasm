use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use wasmtime::{AsContextMut, Caller, Linker};

use crate::{CallbackContext, Error, Host, Result, Runtime, State, UnsafePointer};

type Info = Arc<
    dyn Fn(&mut CallbackContext<'_>, &DecoderSession, UnsafePointer) -> Result<i32> + Send + Sync,
>;
type Open = Arc<dyn Fn(&mut CallbackContext<'_>, &DecoderSession) -> Result<i32> + Send + Sync>;
type Area = Arc<
    dyn Fn(&mut CallbackContext<'_>, &DecoderSession, UnsafePointer, UnsafePointer) -> Result<i32>
        + Send
        + Sync,
>;
type Close = Arc<dyn Fn(&mut CallbackContext<'_>, &DecoderSession) -> Result<()> + Send + Sync>;

/// Synchronous callbacks for a native image decoder.
///
/// Info, open, and area callbacks return `LV_RESULT_INVALID` (0) or `LV_RESULT_OK` (1). Open failure must release its own resources; close is called only for successful sessions. Decoded buffers are not inserted into the native decoded-image cache. Keep their storage alive until close, and release it there. Application locks must be released before guest calls because callbacks can nest.
#[derive(Clone)]
pub struct ImageDecoderCallbacks {
    info: Info,
    open: Open,
    area: Option<Area>,
    close: Option<Close>,
}

impl ImageDecoderCallbacks {
    /// Inspect the source and open a decoding session using native result codes.
    pub fn new(
        info: impl Fn(&mut CallbackContext<'_>, &DecoderSession, UnsafePointer) -> Result<i32>
        + Send
        + Sync
        + 'static,
        open: impl Fn(&mut CallbackContext<'_>, &DecoderSession) -> Result<i32> + Send + Sync + 'static,
    ) -> Self {
        Self {
            info: Arc::new(info),
            open: Arc::new(open),
            area: None,
            close: None,
        }
    }

    /// Decode part of the requested full area and update the decoded-area output.
    pub fn get_area(
        mut self,
        handler: impl Fn(
            &mut CallbackContext<'_>,
            &DecoderSession,
            UnsafePointer,
            UnsafePointer,
        ) -> Result<i32>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        self.area = Some(Arc::new(handler));
        self
    }

    /// Release buffers and other resources owned by a successfully opened session.
    pub fn close(
        mut self,
        handler: impl Fn(&mut CallbackContext<'_>, &DecoderSession) -> Result<()>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        self.close = Some(Arc::new(handler));
        self
    }
}

struct Lifetime {
    pointer: AtomicU32,
    alive: AtomicBool,
}

/// A managed native image decoder. Clones share its registration lifetime.
///
/// Dropping a handle does not unregister it. Explicit cancellation, native deletion, shutdown, failure, and dropping the runtime invalidate all clones. Close externally opened native sessions before shutdown. Use managed cancellation for decoders that may have cached headers. Do not raw-delete a decoder with active sessions or header-cache references, replace its trampolines, or insert it into the decoded-image cache.
#[derive(Clone)]
pub struct ImageDecoder {
    owner: Arc<AtomicBool>,
    id: u32,
    lifetime: Arc<Lifetime>,
}

impl ImageDecoder {
    /// Return the native decoder pointer while its registration and runtime are active.
    pub fn pointer(&self) -> Result<UnsafePointer> {
        if !self.owner.load(Ordering::SeqCst) || !self.lifetime.alive.load(Ordering::SeqCst) {
            return Err(Error::msg("invalid LVGL image decoder reference"));
        }
        let pointer = self.lifetime.pointer.load(Ordering::SeqCst);
        if pointer == 0 {
            return Err(Error::msg("LVGL image decoder creation is not complete"));
        }
        Ok(UnsafePointer(pointer))
    }
}

/// A snapshot of native decoding state. Pointer fields remain borrowed guest addresses.
///
/// `phase` is 1 for info, 2 for open, 3 for area, and 4 for close. `args_flags` bits are stride alignment, premultiplication, no-cache, indexed output, and cache flush, respectively. Info runs before open arguments are copied and exposes its actual output header.
#[derive(Clone, Copy, Debug)]
pub struct DecoderView {
    pub src: UnsafePointer,
    pub source_type: u32,
    pub header: UnsafePointer,
    pub decoded: UnsafePointer,
    pub palette: UnsafePointer,
    pub palette_size: u32,
    pub user_data: UnsafePointer,
    pub decoder_user_data: UnsafePointer,
    pub file: UnsafePointer,
    pub args_flags: u32,
    pub time_to_open: u32,
    pub error_message: UnsafePointer,
    pub phase: u32,
}

/// Native session output written during open, area, or close. Default fields are zero.
///
/// Each write replaces all output fields. Point `decoded` at a valid native draw buffer for complete output, or leave it null until an area callback supplies a block. Keep referenced storage alive for its native use.
#[derive(Clone, Copy, Debug)]
pub struct DecoderOutput {
    pub decoded: UnsafePointer,
    pub palette: UnsafePointer,
    pub palette_size: u32,
    pub user_data: UnsafePointer,
    pub time_to_open: u32,
    pub error_message: UnsafePointer,
}

impl Default for DecoderOutput {
    fn default() -> Self {
        Self {
            decoded: UnsafePointer(0),
            palette: UnsafePointer(0),
            palette_size: 0,
            user_data: UnsafePointer(0),
            time_to_open: 0,
            error_message: UnsafePointer(0),
        }
    }
}

/// A borrowed native session available only for the current synchronous decoder callback.
///
/// Read and write require a context from the owning runtime and the innermost active decoder frame. This type cannot be constructed or cloned by callers. Raw pointers and snapshot fields must not be retained after their native storage expires.
pub struct DecoderSession {
    decoder: ImageDecoder,
    pointer: u32,
    phase: u32,
}

impl DecoderSession {
    /// Return the decoder that owns this callback session.
    pub fn decoder(&self) -> &ImageDecoder {
        &self.decoder
    }

    /// Borrow the opaque native session address for this callback.
    pub fn pointer(&self) -> Result<UnsafePointer> {
        self.decoder.pointer()?;
        Ok(UnsafePointer(self.pointer))
    }

    fn check(&self, context: &CallbackContext<'_>) -> Result<()> {
        if !Arc::ptr_eq(&self.decoder.owner, &context.store.data().lifetime) {
            return Err(Error::msg(
                "LVGL decoder session belongs to another runtime",
            ));
        }
        context.store.data().ensure_ready()?;
        self.pointer()?;
        Ok(())
    }

    /// Read the bridge's versioned 64-byte native session view.
    pub fn read(&self, context: &mut CallbackContext<'_>) -> Result<DecoderView> {
        self.check(context)?;
        let output = context.alloc(64)?;
        let result = (|| {
            let status: i32 = context.call_raw(
                "lvw_decoder_read",
                (self.decoder.pointer()?.0, self.pointer, output, 64u32),
            )?;
            if status != 0 {
                return Err(Error::msg(format!("lvw_decoder_read failed ({status})")));
            }
            let mut bytes = [0; 64];
            context.read_memory(output, &mut bytes)?;
            let words: [u32; 16] = std::array::from_fn(|index| {
                u32::from_le_bytes(bytes[index * 4..index * 4 + 4].try_into().unwrap())
            });
            if words[0] != 64 || words[1] != 1 || words[14] != self.phase {
                context.poison(|| "unsupported LVGL decoder view".to_owned());
                return Err(Error::msg("unsupported LVGL decoder view"));
            }
            Ok(DecoderView {
                src: UnsafePointer(words[2]),
                source_type: words[3],
                header: UnsafePointer(words[4]),
                decoded: UnsafePointer(words[5]),
                palette: UnsafePointer(words[6]),
                palette_size: words[7],
                user_data: UnsafePointer(words[8]),
                decoder_user_data: UnsafePointer(words[9]),
                file: UnsafePointer(words[10]),
                args_flags: words[11],
                time_to_open: words[12],
                error_message: UnsafePointer(words[13]),
                phase: words[14],
            })
        })();
        let cleanup = if matches!(context.store.data().state, State::Ready) {
            context.free(output)
        } else {
            Ok(())
        };
        result.and_then(|view| cleanup.map(|()| view))
    }

    /// Replace native output fields during open, area, or close.
    pub fn write(&self, context: &mut CallbackContext<'_>, output: DecoderOutput) -> Result<()> {
        self.check(context)?;
        let status: i32 = context.call_raw(
            "lvw_decoder_write",
            (
                self.decoder.pointer()?.0,
                self.pointer,
                output.decoded.0,
                output.palette.0,
                output.palette_size,
                output.user_data.0,
                output.time_to_open,
                output.error_message.0,
            ),
        )?;
        if status != 0 {
            return Err(Error::msg(format!("lvw_decoder_write failed ({status})")));
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(super) struct Registration {
    decoder: ImageDecoder,
    callbacks: ImageDecoderCallbacks,
}

impl Host {
    pub(super) fn invalidate_decoders(&self) {
        for registration in self.decoders.values() {
            registration
                .decoder
                .lifetime
                .alive
                .store(false, Ordering::SeqCst);
        }
    }

    fn release_decoder(&mut self, id: u32) {
        if let Some(registration) = self.decoders.remove(&id) {
            registration
                .decoder
                .lifetime
                .alive
                .store(false, Ordering::SeqCst);
        }
    }
}

enum Callback {
    Info(UnsafePointer),
    Open,
    Area(UnsafePointer, UnsafePointer),
    Close,
}

fn dispatch(
    caller: &mut Caller<'_, Host>,
    id: u32,
    decoder: u32,
    dsc: u32,
    callback: Callback,
) -> Result<i32> {
    if matches!(caller.data().state, State::Closing) {
        return Ok(0);
    }
    caller.data().ensure_ready()?;
    let registration = caller
        .data()
        .decoders
        .get(&id)
        .cloned()
        .ok_or_else(|| Error::msg("unknown LVGL decoder callback"))?;
    if dsc == 0 || registration.decoder.pointer()?.0 != decoder {
        return Err(Error::msg("LVGL decoder callback pointer mismatch"));
    }
    let core = caller
        .data()
        .core
        .ok_or_else(|| Error::msg("LVGL core is not instantiated"))?;
    let session = DecoderSession {
        decoder: registration.decoder,
        pointer: dsc,
        phase: match callback {
            Callback::Info(_) => 1,
            Callback::Open => 2,
            Callback::Area(_, _) => 3,
            Callback::Close => 4,
        },
    };
    let mut context = CallbackContext {
        store: caller.as_context_mut(),
        core,
    };
    let result = match callback {
        Callback::Info(header) => (registration.callbacks.info)(&mut context, &session, header)?,
        Callback::Open => (registration.callbacks.open)(&mut context, &session)?,
        Callback::Area(full, decoded) => {
            let handler = registration
                .callbacks
                .area
                .ok_or_else(|| Error::msg("missing LVGL decoder area callback"))?;
            handler(&mut context, &session, full, decoded)?
        }
        Callback::Close => {
            if let Some(handler) = registration.callbacks.close {
                handler(&mut context, &session)?;
            }
            0
        }
    };
    context.store.data().ensure_not_poisoned()?;
    if !matches!(result, 0 | 1) {
        return Err(Error::msg(
            "LVGL decoder callback must return LV_RESULT_INVALID (0) or LV_RESULT_OK (1)",
        ));
    }
    Ok(result)
}

pub(super) fn add_to_linker(linker: &mut Linker<Host>) -> Result<()> {
    linker.func_wrap(
        "lvw",
        "decoder_info",
        |mut caller: Caller<'_, Host>, id: u32, decoder: u32, dsc: u32, header: u32| {
            dispatch(
                &mut caller,
                id,
                decoder,
                dsc,
                Callback::Info(UnsafePointer(header)),
            )
        },
    )?;
    linker.func_wrap(
        "lvw",
        "decoder_open",
        |mut caller: Caller<'_, Host>, id: u32, decoder: u32, dsc: u32| {
            dispatch(&mut caller, id, decoder, dsc, Callback::Open)
        },
    )?;
    linker.func_wrap(
        "lvw",
        "decoder_area",
        |mut caller: Caller<'_, Host>, id: u32, decoder: u32, dsc: u32, full: u32, decoded: u32| {
            dispatch(
                &mut caller,
                id,
                decoder,
                dsc,
                Callback::Area(UnsafePointer(full), UnsafePointer(decoded)),
            )
        },
    )?;
    linker.func_wrap(
        "lvw",
        "decoder_close",
        |mut caller: Caller<'_, Host>, id: u32, decoder: u32, dsc: u32| -> Result<()> {
            dispatch(&mut caller, id, decoder, dsc, Callback::Close)?;
            Ok(())
        },
    )?;
    linker.func_wrap(
        "lvw",
        "decoder_release",
        |mut caller: Caller<'_, Host>, id: u32| {
            caller.data_mut().release_decoder(id);
        },
    )?;
    Ok(())
}

impl Runtime {
    /// Register a decoder with independent native user data and synchronous session callbacks.
    pub fn create_image_decoder(
        &mut self,
        user_data: UnsafePointer,
        callbacks: ImageDecoderCallbacks,
    ) -> Result<ImageDecoder> {
        self.context().create_image_decoder(user_data, callbacks)
    }

    /// Unregister an idle decoder. Active sessions and decoder callbacks reject cancellation.
    pub fn cancel_image_decoder(&mut self, decoder: &ImageDecoder) -> Result<()> {
        self.context().cancel_image_decoder(decoder)
    }
}

impl CallbackContext<'_> {
    /// Register a decoder after checking the complete native bridge capability.
    pub fn create_image_decoder(
        &mut self,
        user_data: UnsafePointer,
        callbacks: ImageDecoderCallbacks,
    ) -> Result<ImageDecoder> {
        self.store.data().ensure_ready()?;
        self.core
            .instance
            .get_typed_func::<(u32, u32, u32), u32>(&mut self.store, "lvw_decoder_create")?;
        self.core
            .instance
            .get_typed_func::<(u32, u32), i32>(&mut self.store, "lvw_decoder_delete")?;
        self.core
            .instance
            .get_typed_func::<(u32, u32, u32, u32), i32>(&mut self.store, "lvw_decoder_read")?;
        self.core
            .instance
            .get_typed_func::<(u32, u32, u32, u32, u32, u32, u32, u32), i32>(
                &mut self.store,
                "lvw_decoder_write",
            )?;
        let id = u32::try_from(self.store.data().next_decoder_id)
            .map_err(|_| Error::msg("LVGL decoder callback IDs exhausted"))?;
        self.store.data_mut().next_decoder_id += 1;
        let decoder = ImageDecoder {
            owner: Arc::clone(&self.store.data().lifetime),
            id,
            lifetime: Arc::new(Lifetime {
                pointer: AtomicU32::new(0),
                alive: AtomicBool::new(true),
            }),
        };
        let flags =
            u32::from(callbacks.area.is_some()) | (u32::from(callbacks.close.is_some()) << 1);
        self.store.data_mut().decoders.insert(
            id,
            Registration {
                decoder: decoder.clone(),
                callbacks,
            },
        );
        match self.call_raw::<_, u32>("lvw_decoder_create", (user_data.0, id, flags)) {
            Ok(pointer) if pointer != 0 => {
                decoder.lifetime.pointer.store(pointer, Ordering::SeqCst);
                decoder.pointer()?;
                Ok(decoder)
            }
            result => {
                self.store.data_mut().release_decoder(id);
                match result {
                    Ok(_) => Err(Error::msg("lvw_decoder_create failed")),
                    Err(error) => Err(error),
                }
            }
        }
    }

    /// Cancel a decoder from this runtime without entering the guest after invalidation.
    ///
    /// Cancellation during any decoder callback or with an open session is a recoverable error. Closing only releases the host registration. Managed cancellation drops header-cache entries; raw deletion requires no active session or header-cache reference.
    pub fn cancel_image_decoder(&mut self, decoder: &ImageDecoder) -> Result<()> {
        if !Arc::ptr_eq(&self.store.data().lifetime, &decoder.owner) {
            return Err(Error::msg("LVGL image decoder belongs to another runtime"));
        }
        if !decoder.lifetime.alive.load(Ordering::SeqCst) {
            return Ok(());
        }
        if matches!(self.store.data().state, State::Closing) {
            self.store.data_mut().release_decoder(decoder.id);
            return Ok(());
        }
        self.store.data().ensure_ready()?;
        let status: i32 =
            self.call_raw("lvw_decoder_delete", (decoder.pointer()?.0, decoder.id))?;
        if status != 0 {
            return Err(Error::msg(format!("lvw_decoder_delete failed ({status})")));
        }
        self.store.data_mut().release_decoder(decoder.id);
        Ok(())
    }
}
