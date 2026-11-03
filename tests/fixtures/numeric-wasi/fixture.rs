#[path = "../numeric-environment/fixture.rs"]
#[allow(dead_code)]
pub mod numeric;

use liblvgl_wasm_host::{
    ModuleInterface, NumericEnvironmentId, NumericHostBinding, NumericWasiClock,
    NumericWasiOptions, NumericWasiOutput, NumericWasiService, load_numeric_environment_with_wasi,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub fn graph(bytes: &[u8], name: &str) -> numeric::Fixture {
    let cases: Value = serde_json::from_slice(bytes).unwrap();
    let mut case = cases
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap()
        .clone();
    case["name"] = json!("dag");
    numeric::Fixture::from_json(&serde_json::to_vec(&[case]).unwrap())
}

pub fn options() -> NumericWasiOptions {
    use NumericWasiService::*;
    NumericWasiOptions {
        id: "host.wasi".into(),
        interface: ModuleInterface {
            name: "wasi".into(),
            version: 1,
        },
        allowed: vec![
            FdWrite,
            FdClose,
            FdSeek,
            EnvironGet,
            EnvironSizesGet,
            ClockTimeGet,
            ProcExit,
        ],
        output_fds: vec![1, 2],
        max_iovecs: 4,
        max_write_bytes: 32,
        max_output_bytes: 128,
        clock: Some(NumericWasiClock {
            realtime_ns: 123,
            monotonic_ns: 456,
        }),
    }
}

type OutputRecord = (String, u32, Vec<u8>, NumericEnvironmentId);

#[derive(Clone, Default)]
pub struct Writes(pub Arc<Mutex<Vec<OutputRecord>>>);
impl NumericWasiOutput for Writes {
    fn write(
        &mut self,
        consumer_id: &str,
        fd: u32,
        bytes: &[u8],
        environment_id: NumericEnvironmentId,
    ) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .push((consumer_id.into(), fd, bytes.to_vec(), environment_id));
        Ok(())
    }
}
impl Writes {
    pub fn messages(&self) -> Vec<(String, u32, String)> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|(id, fd, bytes, _)| (id.clone(), *fd, String::from_utf8(bytes.clone()).unwrap()))
            .collect()
    }
}

pub fn run_positive(json: &[u8]) {
    let graph = graph(json, "dag");
    let input = graph.input();
    let output = Writes::default();
    let mut hosts: [NumericHostBinding<'_>; 0] = [];
    let mut a = load_numeric_environment_with_wasi(
        &input,
        &graph.profile,
        &[],
        &mut hosts,
        &options(),
        Box::new(output.clone()),
    )
    .unwrap();
    let mut b = load_numeric_environment_with_wasi(
        &input,
        &graph.profile,
        &[],
        &mut hosts,
        &options(),
        Box::new(output.clone()),
    )
    .unwrap();
    assert_eq!(a.run(0).unwrap(), 0);
    assert_eq!(a.run(100).unwrap(), 0);
    assert_eq!(b.run(100).unwrap(), 0);
    assert_eq!(a.run(8).unwrap(), 0);
    assert_eq!(a.run(108).unwrap(), 0);
    assert_eq!(a.run(11).unwrap(), 123);
    assert_eq!(b.run(11).unwrap(), 123);
    assert_eq!(a.run(13).unwrap(), 0);
    assert_eq!(a.run(0).unwrap(), 8);
    assert_eq!(a.run(100).unwrap(), 0);
    assert_eq!(b.run(0).unwrap(), 0);
    a.close().unwrap();
    b.close().unwrap();
    let writes = output.0.lock().unwrap();
    assert_eq!(writes.len(), 15);
    assert!(writes[0].3 == writes[1].3 && writes[2].3 == writes[3].3 && writes[0].3 != writes[2].3);
    let messages: Vec<_> = writes
        .iter()
        .map(|(id, fd, bytes, _)| (id.as_str(), *fd, bytes.as_slice()))
        .collect();
    assert_eq!(
        messages,
        [
            ("lib", 2, b"init".as_slice()),
            ("app", 2, b"init".as_slice()),
            ("lib", 2, b"init".as_slice()),
            ("app", 2, b"init".as_slice()),
            ("app", 1, b"APP!".as_slice()),
            ("lib", 1, b"LIB!".as_slice()),
            ("lib", 1, b"LIB!".as_slice()),
            ("app", 1, b"GROW".as_slice()),
            ("lib", 1, b"GROW".as_slice()),
            ("lib", 1, b"LIB!".as_slice()),
            ("app", 1, b"APP!".as_slice()),
            ("app", 2, b"done".as_slice()),
            ("lib", 2, b"done".as_slice()),
            ("app", 2, b"done".as_slice()),
            ("lib", 2, b"done".as_slice())
        ]
    );
}
