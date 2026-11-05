use super::{HostState, instantiation_error, instantiation_panic};
use wasmtime::{Error, Trap};

thread_local! {
    static INJECTED_ERROR: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

pub(super) fn take_injected_error(id: &str) -> Option<Error> {
    INJECTED_ERROR.with(|slot| {
        let mut target = slot.borrow_mut();
        if target.as_deref() == Some(id) {
            target.take();
            Some(Error::msg("injected non-trap instantiation failure"))
        } else {
            None
        }
    })
}

pub(super) fn inject_error(id: &str) {
    INJECTED_ERROR.with(|slot| *slot.borrow_mut() = Some(id.to_owned()));
}

#[test]
fn instantiation_traps_stop_rollback_but_other_errors_allow_it() {
    for trap in [
        Trap::MemoryOutOfBounds,
        Trap::TableOutOfBounds,
        Trap::UnreachableCodeReached,
    ] {
        let mut state = HostState::default();
        let mut rollback = true;
        let failure = Error::from(trap).context("initialization context");
        let error = instantiation_error(&mut state, "app", &failure, &mut rollback);
        assert!(!rollback);
        assert_eq!(state.failure.as_deref(), Some(error.message()));
        assert!(error.message().contains("app"));
        assert!(error.message().contains("initialization context"));
        assert!(error.cleanup_errors().is_empty());
    }
    let mut state = HostState::default();
    let mut rollback = true;
    let failure = Error::msg("ordinary link error");
    let error = instantiation_error(&mut state, "app", &failure, &mut rollback);
    assert!(rollback);
    assert!(state.failure.is_none());
    assert!(error.message().contains("ordinary link error"));
}

#[test]
fn sticky_failure_takes_precedence_over_instantiation_errors() {
    for failure in [
        Error::from(Trap::MemoryOutOfBounds),
        Error::msg("ordinary link error"),
    ] {
        let mut state = HostState {
            failure: Some("first failure".into()),
            exit_code: Some(23),
            ..HostState::default()
        };
        let mut rollback = true;
        let error = instantiation_error(&mut state, "app", &failure, &mut rollback);
        assert!(!rollback);
        assert_eq!(error.message(), "first failure");
        assert_eq!(error.exit_code(), Some(23));
        assert_eq!(state.failure.as_deref(), Some("first failure"));
    }
}

struct SecondDropPanic;
impl Drop for SecondDropPanic {
    fn drop(&mut self) {
        panic!("second payload drop");
    }
}
struct FirstDropPanic;
impl Drop for FirstDropPanic {
    fn drop(&mut self) {
        std::panic::panic_any(SecondDropPanic);
    }
}

#[test]
fn instantiation_panic_stops_rollback_and_preserves_sticky_failure() {
    let mut state = HostState {
        failure: Some("first failure".into()),
        exit_code: Some(23),
        ..HostState::default()
    };
    let mut rollback = true;
    let error = instantiation_panic(&mut state, Box::new(FirstDropPanic), &mut rollback);
    assert!(!rollback);
    assert!(
        error
            .message()
            .starts_with("first failure; subsequent panic with non-string payload")
    );
    assert!(error.message().contains("panic payload drop panicked"));
    assert_eq!(error.exit_code(), Some(23));
    assert_eq!(state.failure.as_deref(), Some("first failure"));
}

fn section(module: &mut Vec<u8>, id: u8, body: &[u8]) {
    assert!(body.len() < 128);
    module.extend([id, body.len() as u8]);
    module.extend(body);
}

fn test_module(init: u8, close: u8, app: bool) -> Vec<u8> {
    let mut module = b"\0asm\x01\0\0\0".to_vec();
    section(
        &mut module,
        1,
        &[
            3, 0x60, 1, 0x7f, 0, 0x60, 0, 1, 0x7f, 0x60, 1, 0x7f, 1, 0x7f,
        ],
    );
    section(
        &mut module,
        2,
        &[
            1, 5, b't', b'r', b'a', b'c', b'e', 9, b'l', b'i', b'f', b'e', b'c', b'y', b'c', b'l',
            b'e', 0, 0,
        ],
    );
    let mut functions = vec![if app { 3 } else { 2 }, 1, 1];
    if app {
        functions.push(2);
    }
    section(&mut module, 3, &functions);
    let mut exports = vec![if app { 3 } else { 2 }];
    for (name, index) in [("module_init", 1), ("module_close", 2)] {
        exports.push(name.len() as u8);
        exports.extend(name.as_bytes());
        exports.extend([0, index]);
    }
    if app {
        exports.extend([7, b'a', b'p', b'p', b'_', b'r', b'u', b'n', 0, 3]);
    }
    section(&mut module, 7, &exports);
    let mut code = vec![if app { 3 } else { 2 }];
    for event in [init, close] {
        code.extend([8, 0, 0x41, event, 0x10, 0, 0x41, 0, 0x0b]);
    }
    if app {
        code.extend([4, 0, 0x20, 0, 0x0b]);
    }
    section(&mut module, 10, &code);
    module
}

#[test]
fn non_trap_instantiation_error_rolls_back_live_providers_and_hosts() {
    use super::numeric_lvgl_test::{interface, manifest, requirement};
    use crate::{
        ManifestRequirement, ModuleArtifactInput, ModuleExport, ModuleHostProvider,
        ModuleManifestInput, ModuleRole, NumericEnvironmentId, NumericFunctionContract,
        NumericHostBinding, NumericHostContract, NumericHostFactory, NumericHostInstance,
        NumericLimits, NumericModuleContract, NumericProfile, NumericResult, inspect_wasm_facts,
        load_numeric_environment,
    };
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Factory(Arc<Mutex<Vec<String>>>);
    struct Host(Arc<Mutex<Vec<String>>>, String);
    impl NumericHostFactory for Factory {
        fn create(
            &mut self,
            id: &str,
            _: NumericEnvironmentId,
        ) -> Result<Box<dyn NumericHostInstance>, String> {
            Ok(Box::new(Host(self.0.clone(), id.into())))
        }
    }
    impl NumericHostInstance for Host {
        fn call(&mut self, name: &str, args: &[i32]) -> Result<Option<i32>, String> {
            assert_eq!(name, "lifecycle");
            assert_eq!(args.len(), 1);
            self.0.lock().unwrap().push(format!("guest:{}", args[0]));
            Ok(None)
        }
        fn close(&mut self) -> Result<(), String> {
            self.0.lock().unwrap().push(format!("host:{}", self.1));
            Ok(())
        }
    }

    let binaries = [
        test_module(10, 11, false),
        test_module(20, 21, false),
        test_module(30, 31, true),
    ];
    let facts: Vec<_> = binaries
        .iter()
        .map(|bytes| inspect_wasm_facts(bytes).unwrap())
        .collect();
    let trace = requirement(&facts[0], "trace", "host.trace", "trace");
    let host = ModuleHostProvider {
        id: "host.trace".into(),
        interface: interface("trace"),
        exports: trace
            .imports
            .iter()
            .map(|item| ModuleExport {
                name: item.name.clone(),
                ty: item.ty.clone(),
            })
            .collect(),
    };
    let mut manifests = Vec::new();
    let mut contracts = Vec::new();
    for (index, id) in ["a", "b", "app"].iter().enumerate() {
        let mut requires = vec![requirement(&facts[index], "trace", "host.trace", "trace")];
        if index > 0 {
            let provider = if index == 1 { "a" } else { "b" };
            requires.push(ManifestRequirement {
                provider: provider.into(),
                interface: provider.into(),
                version: 1,
                imports: vec![],
            });
        }
        let role = if index == 2 {
            ModuleRole::App
        } else {
            ModuleRole::Lib
        };
        manifests.push(manifest(id, role, &facts[index], &[], requires));
        contracts.push(NumericModuleContract {
            id: (*id).into(),
            sha256: facts[index].sha256.clone(),
            interface: interface(id),
            exports: vec![],
        });
    }
    let input = ModuleManifestInput {
        modules: manifests
            .into_iter()
            .zip(&binaries)
            .map(|(manifest, bytes)| ModuleArtifactInput { manifest, bytes })
            .collect(),
        hosts: vec![host],
    };
    let profile = NumericProfile {
        modules: contracts,
        hosts: vec![NumericHostContract {
            id: "host.trace".into(),
            interface: interface("trace"),
            exports: vec![NumericFunctionContract {
                name: "lifecycle".into(),
                params: 1,
                result: NumericResult::Void,
            }],
        }],
        limits: NumericLimits {
            max_memory_pages: 0,
            max_total_memory_pages: 0,
            max_table_elements: 0,
            max_total_table_elements: 0,
        },
    };
    let trace = Arc::new(Mutex::new(Vec::new()));
    let mut factory = Factory(trace.clone());
    let mut bindings = [NumericHostBinding {
        id: "host.trace".into(),
        factory: &mut factory,
    }];
    INJECTED_ERROR.with(|slot| *slot.borrow_mut() = Some("app".into()));
    let error = load_numeric_environment(&input, &profile, &[], &mut bindings).unwrap_err();
    assert!(
        error.message().contains("app")
            && error
                .message()
                .contains("injected non-trap instantiation failure"),
        "{error}"
    );
    assert!(error.cleanup_errors().is_empty(), "{error}");
    assert_eq!(
        *trace.lock().unwrap(),
        [
            "guest:10", "guest:20", "guest:21", "guest:11", "host:app", "host:b", "host:a"
        ]
    );
    INJECTED_ERROR.with(|slot| assert!(slot.borrow().is_none()));
}
