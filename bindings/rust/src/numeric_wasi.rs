//! Bounded WASI Preview 1 services for numeric module graphs.

use std::collections::HashSet;

use crate::module_manifest::{ModuleExternalType, ModuleInterface};
use crate::numeric_environment::NumericEnvironmentId;
use crate::wasm_facts::WasmValueType;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum NumericWasiService {
    EnvironGet,
    EnvironSizesGet,
    FdClose,
    FdSeek,
    FdWrite,
    ProcExit,
    ClockTimeGet,
}
impl NumericWasiService {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::EnvironGet => "environ_get",
            Self::EnvironSizesGet => "environ_sizes_get",
            Self::FdClose => "fd_close",
            Self::FdSeek => "fd_seek",
            Self::FdWrite => "fd_write",
            Self::ProcExit => "proc_exit",
            Self::ClockTimeGet => "clock_time_get",
        }
    }
    pub(crate) fn from_name(name: &str) -> Option<Self> {
        [
            Self::EnvironGet,
            Self::EnvironSizesGet,
            Self::FdClose,
            Self::FdSeek,
            Self::FdWrite,
            Self::ProcExit,
            Self::ClockTimeGet,
        ]
        .into_iter()
        .find(|service| service.name() == name)
    }
    pub(crate) fn matches(self, ty: &ModuleExternalType) -> bool {
        use WasmValueType::{I32, I64};
        let (params, result): (&[WasmValueType], &[WasmValueType]) = match self {
            Self::EnvironGet | Self::EnvironSizesGet => (&[I32, I32], &[I32]),
            Self::FdClose => (&[I32], &[I32]),
            Self::FdSeek => (&[I32, I64, I32, I32], &[I32]),
            Self::FdWrite => (&[I32, I32, I32, I32], &[I32]),
            Self::ProcExit => (&[I32], &[]),
            Self::ClockTimeGet => (&[I32, I64, I32], &[I32]),
        };
        matches!(ty, ModuleExternalType::Function { params: p, results: r } if p == params && r == result)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NumericWasiClock {
    pub realtime_ns: u64,
    pub monotonic_ns: u64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NumericWasiOptions {
    pub id: String,
    pub interface: ModuleInterface,
    pub allowed: Vec<NumericWasiService>,
    pub output_fds: Vec<u32>,
    pub max_iovecs: u32,
    pub max_write_bytes: u32,
    pub max_output_bytes: u32,
    pub clock: Option<NumericWasiClock>,
}
/// A synchronous output sink. The supplied bytes are copied from guest memory.
pub trait NumericWasiOutput {
    fn write(
        &mut self,
        consumer_id: &str,
        fd: u32,
        bytes: &[u8],
        environment_id: NumericEnvironmentId,
    ) -> Result<(), String>;
}
impl NumericWasiOptions {
    pub(crate) fn valid(&self) -> bool {
        if self.allowed.len() > 7 || self.output_fds.len() > 2 {
            return false;
        }
        let services: HashSet<_> = self.allowed.iter().copied().collect();
        let fds: HashSet<_> = self.output_fds.iter().copied().collect();
        self.allowed.len() <= 7
            && services.len() == self.allowed.len()
            && self.output_fds.len() <= 2
            && fds.len() == self.output_fds.len()
            && self.output_fds.iter().all(|fd| *fd == 1 || *fd == 2)
            && self.max_iovecs <= 4096
            && self.max_write_bytes <= 16 * 1024 * 1024
            && self.max_output_bytes <= 64 * 1024 * 1024
            && (!services.contains(&NumericWasiService::ClockTimeGet) || self.clock.is_some())
    }
}

pub(crate) struct WasiSlot {
    pub consumer: String,
    pub memory: Option<wasmtime::Memory>,
    pub fds: [bool; 3],
}
pub(crate) struct WasiState {
    pub options: NumericWasiOptions,
    pub output: Option<Box<dyn NumericWasiOutput>>,
    pub slots: Vec<WasiSlot>,
    pub used: u32,
    pub environment: NumericEnvironmentId,
}
impl WasiState {
    pub fn add_slot(&mut self, consumer: String) -> usize {
        let index = self.slots.len();
        self.slots.push(WasiSlot {
            consumer,
            memory: None,
            fds: [
                false,
                self.options.output_fds.contains(&1),
                self.options.output_fds.contains(&2),
            ],
        });
        index
    }
}

fn u32arg(values: &[wasmtime::Val], index: usize) -> u32 {
    match values[index] {
        wasmtime::Val::I32(value) => value as u32,
        _ => unreachable!("validated WASI signature"),
    }
}
fn valid_range(size: usize, pointer: u32, length: usize) -> bool {
    let pointer = pointer as usize;
    pointer <= size && length <= size - pointer
}
fn put_u32(
    caller: &mut wasmtime::Caller<'_, crate::numeric_environment::HostState>,
    memory: wasmtime::Memory,
    pointer: u32,
    value: u32,
) {
    memory.data_mut(caller)[pointer as usize..pointer as usize + 4]
        .copy_from_slice(&value.to_le_bytes());
}

pub(crate) fn function(
    store: &mut wasmtime::Store<crate::numeric_environment::HostState>,
    ty: wasmtime::FuncType,
    slot: usize,
    service: NumericWasiService,
) -> Result<wasmtime::Func, String> {
    wasmtime::Func::try_new(store, ty, move |mut caller, values, results| {
        let error = caller.data().failure.clone();
        if let Some(message) = error {
            return Err(wasmtime::Error::msg(message));
        }
        let errno = invoke(&mut caller, slot, service, values)?;
        if let Some(value) = errno {
            results[0] = wasmtime::Val::I32(value);
        }
        Ok(())
    })
    .map_err(|error| format!("numeric WASI host creation failed: {error:#}"))
}
fn invoke(
    caller: &mut wasmtime::Caller<'_, crate::numeric_environment::HostState>,
    index: usize,
    service: NumericWasiService,
    values: &[wasmtime::Val],
) -> Result<Option<i32>, wasmtime::Error> {
    use NumericWasiService::*;
    const OK: i32 = 0;
    const BADF: i32 = 8;
    const FAULT: i32 = 21;
    const INVAL: i32 = 28;
    const NOSPC: i32 = 51;
    const NOTSUP: i32 = 58;
    const SPIPE: i32 = 70;
    let memory = caller
        .data()
        .wasi
        .as_ref()
        .and_then(|w| w.slots[index].memory);
    let Some(memory) = memory else {
        return match service {
            ProcExit => Err(wasmtime::Error::msg("numeric WASI consumer is unavailable")),
            FdClose | FdSeek | FdWrite => Ok(Some(BADF)),
            ClockTimeGet if u32arg(values, 0) > 3 => Ok(Some(INVAL)),
            ClockTimeGet if u32arg(values, 0) > 1 => Ok(Some(NOTSUP)),
            _ => Ok(Some(FAULT)),
        };
    };
    let size = memory.data_size(&*caller);
    match service {
        EnvironGet => Ok(Some(OK)),
        EnvironSizesGet => {
            let a = u32arg(values, 0);
            let b = u32arg(values, 1);
            if !valid_range(size, a, 4) || !valid_range(size, b, 4) {
                return Ok(Some(FAULT));
            }
            put_u32(caller, memory, a, 0);
            put_u32(caller, memory, b, 0);
            Ok(Some(OK))
        }
        FdClose | FdSeek | FdWrite => {
            let fd = u32arg(values, 0);
            if fd > 2
                || !caller.data().wasi.as_ref().expect("WASI state").slots[index].fds[fd as usize]
            {
                return Ok(Some(BADF));
            }
            if service == FdClose {
                caller.data_mut().wasi.as_mut().expect("WASI state").slots[index].fds
                    [fd as usize] = false;
                return Ok(Some(OK));
            }
            if service == FdSeek {
                return Ok(Some(SPIPE));
            }
            let pointer = u32arg(values, 1);
            let count = u32arg(values, 2);
            let written = u32arg(values, 3);
            let options = &caller.data().wasi.as_ref().expect("WASI state").options;
            if count > options.max_iovecs {
                return Ok(Some(INVAL));
            }
            if !valid_range(size, pointer, count as usize * 8) || !valid_range(size, written, 4) {
                return Ok(Some(FAULT));
            }
            let mut ranges = Vec::with_capacity(count as usize);
            let mut total = 0u64;
            let data = memory.data(&*caller);
            for n in 0..count as usize {
                let pos = pointer as usize + n * 8;
                let start =
                    u32::from_le_bytes(data[pos..pos + 4].try_into().expect("validated range"));
                let len =
                    u32::from_le_bytes(data[pos + 4..pos + 8].try_into().expect("validated range"));
                if !valid_range(size, start, len as usize) {
                    return Ok(Some(FAULT));
                }
                total += u64::from(len);
                if total > u64::from(options.max_write_bytes) || total > u64::from(u32::MAX) {
                    return Ok(Some(INVAL));
                }
                ranges.push((start, len));
            }
            let wasi = caller.data().wasi.as_ref().expect("WASI state");
            if total > u64::from(wasi.options.max_output_bytes - wasi.used) {
                return Ok(Some(NOSPC));
            }
            let mut bytes = Vec::with_capacity(total as usize);
            for (start, len) in ranges {
                bytes.extend_from_slice(&data[start as usize..start as usize + len as usize]);
            }
            if total != 0 {
                let wasi = caller.data_mut().wasi.as_mut().expect("WASI state");
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    wasi.output.as_mut().expect("WASI output").write(
                        &wasi.slots[index].consumer,
                        fd,
                        &bytes,
                        wasi.environment.clone(),
                    )
                }));
                let message = match result {
                    Ok(Ok(())) => None,
                    Ok(Err(message)) => Some(message),
                    Err(panic) => Some(crate::numeric_environment::panic_message(panic)),
                };
                if let Some(message) = message {
                    return Err(wasmtime::Error::msg(caller.data_mut().poison(message)));
                }
                if let Some(message) = caller.data().failure.clone() {
                    return Err(wasmtime::Error::msg(message));
                }
            }
            put_u32(caller, memory, written, total as u32);
            caller.data_mut().wasi.as_mut().expect("WASI state").used += total as u32;
            Ok(Some(OK))
        }
        ClockTimeGet => {
            let id = u32arg(values, 0);
            if id > 3 {
                return Ok(Some(INVAL));
            }
            if id > 1 {
                return Ok(Some(NOTSUP));
            }
            let pointer = u32arg(values, 2);
            if !valid_range(size, pointer, 8) {
                return Ok(Some(FAULT));
            }
            let clock = caller
                .data()
                .wasi
                .as_ref()
                .expect("WASI state")
                .options
                .clock
                .expect("authorized clock");
            let value = if id == 0 {
                clock.realtime_ns
            } else {
                clock.monotonic_ns
            };
            memory.data_mut(caller)[pointer as usize..pointer as usize + 8]
                .copy_from_slice(&value.to_le_bytes());
            Ok(Some(OK))
        }
        ProcExit => {
            let code = u32arg(values, 0);
            caller.data_mut().exit_code = Some(code);
            let message = caller
                .data_mut()
                .poison(format!("WASI process exited with code {code}"));
            Err(wasmtime::Error::msg(message))
        }
    }
}
